"""
HesterDocs Embedding Service - Index and search documentation with vector embeddings.

Uses Supabase (hester.doc_embeddings) for storage and Google's embedding model.
"""

import hashlib
import logging
import os
import re
import subprocess
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from google import genai
from postgrest.exceptions import APIError
from supabase import create_client, Client

logger = logging.getLogger("hester.docs.embeddings")

# Embedding config
EMBEDDING_MODEL = "gemini-embedding-001"
EMBEDDING_DIMENSIONS = 768

# Database config
DOC_EMBEDDINGS_TABLE = "doc_embeddings"
DOC_EMBEDDINGS_SCHEMA = "hester"


def get_repo_info(working_dir: str) -> Tuple[str, Path]:
    """
    Get repository name and root path from working directory.

    Args:
        working_dir: Current working directory

    Returns:
        Tuple of (repo_name, repo_root_path)

    Raises:
        ValueError: If not in a git repository
    """
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            cwd=working_dir,
            capture_output=True,
            text=True,
            check=True,
        )
        repo_root = Path(result.stdout.strip())
        repo_name = repo_root.name
        return repo_name, repo_root
    except subprocess.CalledProcessError:
        raise ValueError(f"Not a git repository: {working_dir}")


def get_relative_path(file_path: str, repo_root: Path) -> str:
    """Convert absolute path to repo-relative path."""
    abs_path = Path(file_path).resolve()
    return str(abs_path.relative_to(repo_root))


def content_hash(text: str) -> str:
    """Generate SHA256 hash of content for cache invalidation."""
    return hashlib.sha256(text.encode()).hexdigest()


def chunk_markdown(content: str, max_tokens: int = 500) -> List[Dict[str, Any]]:
    """
    Chunk markdown content by sections.

    Splits on headings, keeping chunks under max_tokens (approx).
    Each chunk includes its heading context.

    Args:
        content: Markdown content
        max_tokens: Approximate max tokens per chunk (1 token ≈ 4 chars)

    Returns:
        List of {text, heading, start_line} dicts
    """
    max_chars = max_tokens * 4
    chunks = []

    # Split by headings
    heading_pattern = r'^(#{1,6})\s+(.+)$'
    lines = content.split('\n')

    current_chunk = []
    current_heading = ""
    current_start = 0
    current_length = 0

    for i, line in enumerate(lines):
        heading_match = re.match(heading_pattern, line)

        if heading_match:
            # Save previous chunk if not empty
            if current_chunk:
                chunk_text = '\n'.join(current_chunk).strip()
                if chunk_text:
                    chunks.append({
                        'text': chunk_text,
                        'heading': current_heading,
                        'start_line': current_start + 1,
                    })

            # Start new chunk with heading
            current_heading = heading_match.group(2)
            current_chunk = [line]
            current_start = i
            current_length = len(line)

        else:
            # Check if adding this line would exceed limit
            if current_length + len(line) > max_chars and current_chunk:
                # Save current chunk
                chunk_text = '\n'.join(current_chunk).strip()
                if chunk_text:
                    chunks.append({
                        'text': chunk_text,
                        'heading': current_heading,
                        'start_line': current_start + 1,
                    })
                # Start new chunk (keeping heading context)
                current_chunk = [f"## {current_heading} (continued)", line] if current_heading else [line]
                current_start = i
                current_length = len(line)
            else:
                current_chunk.append(line)
                current_length += len(line)

    # Don't forget the last chunk
    if current_chunk:
        chunk_text = '\n'.join(current_chunk).strip()
        if chunk_text:
            chunks.append({
                'text': chunk_text,
                'heading': current_heading,
                'start_line': current_start + 1,
            })

    return chunks


class DocEmbeddingService:
    """
    Service for indexing and searching documentation with embeddings.

    Uses:
    - shared/embeddings/generator.py for embedding generation
    - Supabase hester.doc_embeddings for storage
    - pgvector for similarity search
    """

    def __init__(self, working_dir: str):
        """
        Initialize the embedding service.

        Args:
            working_dir: Working directory (must be in a git repo)
        """
        self.working_dir = working_dir
        self.repo_name, self.repo_root = get_repo_info(working_dir)

        # Lazy initialized
        self._supabase = None
        self._genai_configured = False

    def _get_genai_client(self) -> genai.Client:
        """Get or create Gemini client."""
        if not hasattr(self, '_genai_client') or self._genai_client is None:
            api_key = os.environ.get("GOOGLE_API_KEY")
            if not api_key:
                raise ValueError("GOOGLE_API_KEY environment variable not set")
            self._genai_client = genai.Client(api_key=api_key)
        return self._genai_client

    @property
    def supabase(self) -> Client:
        """Lazy load Supabase client."""
        if self._supabase is None:
            url = os.environ.get("SUPABASE_URL")
            key = os.environ.get("SUPABASE_SERVICE_KEY") or os.environ.get("SUPABASE_ANON_KEY")
            if not url or not key:
                raise ValueError(
                    "SUPABASE_URL and SUPABASE_SERVICE_KEY/SUPABASE_ANON_KEY required. "
                    "For local dev, run `npx supabase status` and update .env with current keys."
                )
            self._supabase = create_client(url, key)
        return self._supabase

    def _table(self, name: str = DOC_EMBEDDINGS_TABLE):
        """Get table with schema prefix."""
        return self.supabase.schema(DOC_EMBEDDINGS_SCHEMA).table(name)

    async def _generate_embedding(self, text: str) -> List[float]:
        """Generate embedding for text using Google's embedding model."""
        client = self._get_genai_client()
        result = client.models.embed_content(
            model=EMBEDDING_MODEL,
            contents=text,
            config={"output_dimensionality": EMBEDDING_DIMENSIONS},
        )
        # The new API returns embeddings differently
        return result.embeddings[0].values

    async def index_file(self, file_path: str) -> Dict[str, Any]:
        """
        Index a documentation file, updating embeddings if content changed.

        Args:
            file_path: Path to markdown file (absolute, relative to cwd, or relative to repo root)

        Returns:
            Dict with indexing stats
        """
        abs_path = Path(file_path)

        if not abs_path.is_absolute():
            # Try relative to working_dir first
            candidate = Path(self.working_dir) / file_path
            if candidate.exists():
                abs_path = candidate
            else:
                # Try relative to repo root
                candidate = self.repo_root / file_path
                if candidate.exists():
                    abs_path = candidate
                else:
                    abs_path = Path(self.working_dir) / file_path  # For error message

        if not abs_path.exists():
            return {"success": False, "error": f"File not found: {file_path}"}

        relative_path = get_relative_path(str(abs_path), self.repo_root)

        # Read and chunk content
        content = abs_path.read_text()
        chunks = chunk_markdown(content)

        if not chunks:
            return {"success": True, "chunks_indexed": 0, "skipped": True}

        # Check existing embeddings
        existing = self._table().select(
            "chunk_index, content_hash"
        ).eq("repo_name", self.repo_name).eq("file_path", relative_path).execute()

        existing_hashes = {
            row["chunk_index"]: row["content_hash"]
            for row in (existing.data or [])
        }

        # Index each chunk
        indexed = 0
        skipped = 0

        for i, chunk in enumerate(chunks):
            chunk_hash = content_hash(chunk["text"])

            # Skip if unchanged
            if existing_hashes.get(i) == chunk_hash:
                skipped += 1
                continue

            # Generate embedding
            embedding = await self._generate_embedding(chunk["text"])

            # Upsert to database
            self._table().upsert({
                "repo_name": self.repo_name,
                "file_path": relative_path,
                "content_hash": chunk_hash,
                "chunk_index": i,
                "chunk_text": chunk["text"],
                "embedding": embedding,
            }, on_conflict="repo_name,file_path,chunk_index").execute()

            indexed += 1

        # Remove stale chunks (file got shorter)
        if len(chunks) < len(existing_hashes):
            self._table().delete().eq(
                "repo_name", self.repo_name
            ).eq("file_path", relative_path).gte(
                "chunk_index", len(chunks)
            ).execute()

        return {
            "success": True,
            "file_path": relative_path,
            "chunks_indexed": indexed,
            "chunks_skipped": skipped,
            "total_chunks": len(chunks),
        }

    async def index_directory(
        self,
        patterns: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        """
        Index all documentation files matching patterns.

        Args:
            patterns: Glob patterns (default: ["**/*.md", "**/README*"])

        Returns:
            Dict with indexing stats
        """
        import glob

        patterns = patterns or ["**/*.md", "**/README*"]

        all_files = set()
        for pattern in patterns:
            matches = glob.glob(
                str(self.repo_root / pattern),
                recursive=True,
            )
            all_files.update(matches)

        # Filter out obvious non-docs
        doc_files = [
            f for f in all_files
            if not any(skip in f for skip in [
                "node_modules", ".git", "venv", "__pycache__",
                ".egg-info", "build/", "dist/"
            ])
        ]

        results = {
            "success": True,
            "files_processed": 0,
            "files_skipped": 0,
            "total_chunks": 0,
            "chunks_indexed": 0,
        }

        for file_path in doc_files:
            try:
                result = await self.index_file(file_path)
                if result.get("success"):
                    results["files_processed"] += 1
                    results["total_chunks"] += result.get("total_chunks", 0)
                    results["chunks_indexed"] += result.get("chunks_indexed", 0)
                else:
                    results["files_skipped"] += 1
            except Exception as e:
                logger.warning(f"Failed to index {file_path}: {e}")
                results["files_skipped"] += 1

        return results

    async def search(
        self,
        query: str,
        limit: int = 5,
        min_similarity: float = 0.5,
    ) -> List[Dict[str, Any]]:
        """
        Semantic search over indexed documentation.

        Args:
            query: Search query
            limit: Maximum results
            min_similarity: Minimum cosine similarity threshold

        Returns:
            List of matching chunks with similarity scores
        """
        # Generate query embedding
        query_embedding = await self._generate_embedding(query)

        # Search using pgvector via RPC in hester schema
        try:
            result = self.supabase.schema(DOC_EMBEDDINGS_SCHEMA).rpc(
                "match_doc_embeddings",
                {
                    "query_embedding": query_embedding,
                    "match_repo": self.repo_name,
                    "match_count": limit,
                    "min_similarity": min_similarity,
                }
            ).execute()
            return result.data or []
        except APIError as e:
            if "PGRST301" in str(e) or "No suitable key" in str(e):
                raise ValueError(
                    "JWT key mismatch — local Supabase keys have changed. "
                    "Run `npx supabase status` and update SUPABASE_SERVICE_KEY / "
                    "SUPABASE_ANON_KEY in .env to match, then re-source your env."
                ) from e
            raise

    async def get_indexed_files(self) -> List[str]:
        """Get list of files currently indexed for this repo."""
        try:
            result = self.supabase.schema(DOC_EMBEDDINGS_SCHEMA).rpc(
                "get_indexed_doc_files",
                {"match_repo": self.repo_name}
            ).execute()
            return [row["file_path"] for row in (result.data or [])]
        except APIError as e:
            if "PGRST301" in str(e) or "No suitable key" in str(e):
                raise ValueError(
                    "JWT key mismatch — local Supabase keys have changed. "
                    "Run `npx supabase status` and update SUPABASE_SERVICE_KEY / "
                    "SUPABASE_ANON_KEY in .env to match, then re-source your env."
                ) from e
            raise

    async def clear_index(self, file_path: Optional[str] = None) -> int:
        """
        Clear embeddings from index.

        Args:
            file_path: Specific file to clear, or None for all files

        Returns:
            Number of rows deleted
        """
        query = self._table().delete().eq(
            "repo_name", self.repo_name
        )

        if file_path:
            relative_path = get_relative_path(file_path, self.repo_root)
            query = query.eq("file_path", relative_path)

        result = query.execute()
        return len(result.data or [])
