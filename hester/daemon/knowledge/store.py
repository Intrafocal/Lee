"""
KnowledgeStore - Redis-based storage for bundle and doc embeddings.

Provides unified Redis storage with sub-millisecond access for:
- Context bundle embeddings and metadata
- Documentation chunk embeddings and metadata

Redis Schema:
- hester:bundle:{id}:meta      - JSON metadata
- hester:bundle:{id}:content   - String content
- hester:bundle:{id}:embedding - Binary (768 float32)
- hester:bundles:index         - Set of bundle IDs

- hester:doc:{hash}:meta       - JSON metadata
- hester:doc:{hash}:chunk      - String chunk text
- hester:doc:{hash}:embedding  - Binary (768 float32)
- hester:docs:index            - Set of chunk hashes
- hester:docs:by_file:{path}   - Set of chunk hashes per file
- hester:docs:last_sync        - ISO timestamp
"""

import json
import logging
import struct
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, TYPE_CHECKING

import numpy as np

if TYPE_CHECKING:
    import redis.asyncio as redis

logger = logging.getLogger("hester.daemon.knowledge.store")

# Redis key prefixes
BUNDLE_PREFIX = "hester:bundle:"
DOC_PREFIX = "hester:doc:"
BUNDLES_INDEX = "hester:bundles:index"
DOCS_INDEX = "hester:docs:index"
DOCS_BY_FILE_PREFIX = "hester:docs:by_file:"
DOCS_LAST_SYNC = "hester:docs:last_sync"

# TTL for bundle/doc entries (7 days)
DEFAULT_TTL = 86400 * 7


class KnowledgeStore:
    """
    Unified Redis storage for bundle and doc embeddings.

    Provides fast access to pre-computed embeddings for:
    - Context bundles (synthesized knowledge packages)
    - Documentation chunks (indexed markdown sections)

    Usage:
        store = KnowledgeStore(redis_client)

        # Sync bundles to Redis
        await store.sync_bundles_to_redis()

        # Get bundle
        content = await store.get_bundle_content("auth-system")
        embedding = await store.get_bundle_embedding("auth-system")

        # Sync docs from Supabase
        await store.sync_docs_from_supabase()

        # Get doc chunk
        chunk = await store.get_doc_chunk("abc123")
        embedding = await store.get_doc_embedding("abc123")
    """

    def __init__(
        self,
        redis_client: Optional["redis.Redis"] = None,
        working_dir: Optional[Path] = None,
    ):
        """
        Initialize the knowledge store.

        Args:
            redis_client: Optional Redis client (store is unavailable if None)
            working_dir: Working directory for bundle file access
        """
        self._redis = redis_client
        self._working_dir = Path(working_dir) if working_dir else Path.cwd()
        self._available = redis_client is not None

    @property
    def is_available(self) -> bool:
        """Check if Redis is available."""
        return self._available

    # =========================================================================
    # Bundle Operations
    # =========================================================================

    async def sync_bundles_to_redis(self) -> int:
        """
        Sync context bundles from BundleService to Redis.

        Reads bundles from the bundle service and stores embeddings in Redis
        for fast semantic matching.

        Returns:
            Number of bundles synced
        """
        if not self._available:
            logger.warning("KnowledgeStore unavailable: Redis not connected")
            return 0

        try:
            from ...context.service import BundleService

            service = BundleService(working_dir=self._working_dir)
            bundles = await service.list_bundles()

            count = 0
            for bundle in bundles:
                try:
                    # Get full bundle with content
                    full_bundle = await service.get_bundle(bundle.name)
                    if not full_bundle:
                        continue

                    # Store in Redis
                    await self._store_bundle(
                        bundle_id=bundle.name,
                        meta={
                            "title": bundle.name,
                            "tags": list(bundle.tags) if bundle.tags else [],
                            "ttl_hours": bundle.ttl_hours,
                            "stale": bundle.is_stale,
                            "updated_at": bundle.updated_at.isoformat() if bundle.updated_at else None,
                        },
                        content=full_bundle.content or "",
                    )
                    count += 1
                except Exception as e:
                    logger.warning(f"Failed to sync bundle {bundle.name}: {e}")

            logger.info(f"Synced {count} bundles to Redis")
            return count

        except Exception as e:
            logger.error(f"Failed to sync bundles: {e}")
            return 0

    async def _store_bundle(
        self,
        bundle_id: str,
        meta: Dict[str, Any],
        content: str,
        embedding: Optional[np.ndarray] = None,
    ) -> None:
        """Store bundle data in Redis."""
        if not self._available or not self._redis:
            return

        # Generate embedding if not provided
        if embedding is None and content:
            try:
                from ..semantic.embeddings import EmbeddingService
                service = EmbeddingService(redis_client=self._redis)
                embedding = await service.embed(content[:8000])  # Truncate for embedding
            except Exception as e:
                logger.debug(f"Failed to generate bundle embedding: {e}")

        # Store metadata
        await self._redis.setex(
            f"{BUNDLE_PREFIX}{bundle_id}:meta",
            DEFAULT_TTL,
            json.dumps(meta),
        )

        # Store content
        await self._redis.setex(
            f"{BUNDLE_PREFIX}{bundle_id}:content",
            DEFAULT_TTL,
            content,
        )

        # Store embedding
        if embedding is not None:
            embedding_bytes = struct.pack(f"{len(embedding)}f", *embedding.tolist())
            await self._redis.setex(
                f"{BUNDLE_PREFIX}{bundle_id}:embedding",
                DEFAULT_TTL,
                embedding_bytes,
            )

        # Add to index
        await self._redis.sadd(BUNDLES_INDEX, bundle_id)

    async def get_bundle_meta(self, bundle_id: str) -> Optional[Dict[str, Any]]:
        """Get bundle metadata."""
        if not self._available or not self._redis:
            return None

        data = await self._redis.get(f"{BUNDLE_PREFIX}{bundle_id}:meta")
        if data:
            return json.loads(data)
        return None

    async def get_bundle_content(self, bundle_id: str) -> Optional[str]:
        """Get bundle content."""
        if not self._available or not self._redis:
            return None

        data = await self._redis.get(f"{BUNDLE_PREFIX}{bundle_id}:content")
        if data:
            return data.decode() if isinstance(data, bytes) else data
        return None

    async def get_bundle_embedding(self, bundle_id: str) -> Optional[np.ndarray]:
        """Get bundle embedding."""
        if not self._available or not self._redis:
            return None

        data = await self._redis.get(f"{BUNDLE_PREFIX}{bundle_id}:embedding")
        if data:
            return self._deserialize_embedding(data)
        return None

    async def list_bundles(self) -> List[str]:
        """List all bundle IDs in Redis."""
        if not self._available or not self._redis:
            return []

        bundle_ids = await self._redis.smembers(BUNDLES_INDEX)
        return [
            bid.decode() if isinstance(bid, bytes) else bid
            for bid in bundle_ids
        ]

    async def delete_bundle(self, bundle_id: str) -> bool:
        """Delete a bundle from Redis."""
        if not self._available or not self._redis:
            return False

        await self._redis.delete(
            f"{BUNDLE_PREFIX}{bundle_id}:meta",
            f"{BUNDLE_PREFIX}{bundle_id}:content",
            f"{BUNDLE_PREFIX}{bundle_id}:embedding",
        )
        await self._redis.srem(BUNDLES_INDEX, bundle_id)
        return True

    # =========================================================================
    # Doc Operations
    # =========================================================================

    async def sync_docs_from_supabase(self, incremental: bool = True) -> int:
        """
        Sync doc embeddings from Supabase to Redis.

        Reads doc embeddings from Supabase hester.doc_embeddings table
        and caches them in Redis for fast semantic matching.

        Args:
            incremental: If True, only sync docs newer than last sync

        Returns:
            Number of docs synced
        """
        if not self._available:
            logger.warning("KnowledgeStore unavailable: Redis not connected")
            return 0

        try:
            import os
            from supabase import create_client

            url = os.environ.get("SUPABASE_URL")
            key = os.environ.get("SUPABASE_SERVICE_KEY") or os.environ.get("SUPABASE_ANON_KEY")

            if not url or not key:
                logger.warning("Supabase credentials not available for doc sync")
                return 0

            supabase = create_client(url, key)

            # Build query
            query = supabase.schema("hester").table("doc_embeddings").select(
                "id, repo_name, file_path, chunk_index, heading, content_hash, chunk_text, embedding, created_at"
            )

            # Add incremental filter if needed
            if incremental and self._redis:
                last_sync = await self._redis.get(DOCS_LAST_SYNC)
                if last_sync:
                    last_sync_str = last_sync.decode() if isinstance(last_sync, bytes) else last_sync
                    query = query.gt("created_at", last_sync_str)

            result = query.execute()

            if not result.data:
                return 0

            count = 0
            for row in result.data:
                try:
                    doc_hash = row.get("content_hash") or str(row.get("id"))

                    # Store doc in Redis
                    await self._store_doc(
                        doc_hash=doc_hash,
                        meta={
                            "file_path": row.get("file_path", ""),
                            "heading": row.get("heading", ""),
                            "chunk_index": row.get("chunk_index", 0),
                            "repo_name": row.get("repo_name", ""),
                        },
                        chunk_text=row.get("chunk_text", ""),
                        embedding=row.get("embedding"),  # Already a list from Supabase
                    )
                    count += 1
                except Exception as e:
                    logger.debug(f"Failed to sync doc {row.get('id')}: {e}")

            # Update last sync timestamp
            if self._redis:
                await self._redis.set(DOCS_LAST_SYNC, datetime.utcnow().isoformat())

            logger.info(f"Synced {count} docs from Supabase to Redis")
            return count

        except Exception as e:
            logger.error(f"Failed to sync docs from Supabase: {e}")
            return 0

    async def _store_doc(
        self,
        doc_hash: str,
        meta: Dict[str, Any],
        chunk_text: str,
        embedding: Optional[List[float]] = None,
    ) -> None:
        """Store doc data in Redis."""
        if not self._available or not self._redis:
            return

        # Store metadata
        await self._redis.setex(
            f"{DOC_PREFIX}{doc_hash}:meta",
            DEFAULT_TTL,
            json.dumps(meta),
        )

        # Store chunk text
        await self._redis.setex(
            f"{DOC_PREFIX}{doc_hash}:chunk",
            DEFAULT_TTL,
            chunk_text,
        )

        # Store embedding
        if embedding:
            if isinstance(embedding, list):
                embedding_array = np.array(embedding, dtype=np.float32)
            else:
                embedding_array = embedding
            embedding_bytes = struct.pack(f"{len(embedding_array)}f", *embedding_array.tolist())
            await self._redis.setex(
                f"{DOC_PREFIX}{doc_hash}:embedding",
                DEFAULT_TTL,
                embedding_bytes,
            )

        # Add to index
        await self._redis.sadd(DOCS_INDEX, doc_hash)

        # Add to by-file index
        file_path = meta.get("file_path", "")
        if file_path:
            await self._redis.sadd(f"{DOCS_BY_FILE_PREFIX}{file_path}", doc_hash)

    async def get_doc_meta(self, doc_hash: str) -> Optional[Dict[str, Any]]:
        """Get doc metadata."""
        if not self._available or not self._redis:
            return None

        data = await self._redis.get(f"{DOC_PREFIX}{doc_hash}:meta")
        if data:
            return json.loads(data)
        return None

    async def get_doc_chunk(self, doc_hash: str) -> Optional[str]:
        """Get doc chunk text."""
        if not self._available or not self._redis:
            return None

        data = await self._redis.get(f"{DOC_PREFIX}{doc_hash}:chunk")
        if data:
            return data.decode() if isinstance(data, bytes) else data
        return None

    async def get_doc_embedding(self, doc_hash: str) -> Optional[np.ndarray]:
        """Get doc embedding."""
        if not self._available or not self._redis:
            return None

        data = await self._redis.get(f"{DOC_PREFIX}{doc_hash}:embedding")
        if data:
            return self._deserialize_embedding(data)
        return None

    async def list_docs(self) -> List[str]:
        """List all doc hashes in Redis."""
        if not self._available or not self._redis:
            return []

        doc_hashes = await self._redis.smembers(DOCS_INDEX)
        return [
            dhash.decode() if isinstance(dhash, bytes) else dhash
            for dhash in doc_hashes
        ]

    async def get_indexed_files(self) -> List[str]:
        """Get list of files that have indexed docs."""
        if not self._available or not self._redis:
            return []

        # Get all keys matching the by-file pattern
        keys = await self._redis.keys(f"{DOCS_BY_FILE_PREFIX}*")
        files = []
        for key in keys:
            key_str = key.decode() if isinstance(key, bytes) else key
            file_path = key_str.replace(DOCS_BY_FILE_PREFIX, "")
            files.append(file_path)
        return sorted(files)

    async def get_docs_for_file(self, file_path: str) -> List[str]:
        """Get doc hashes for a specific file."""
        if not self._available or not self._redis:
            return []

        doc_hashes = await self._redis.smembers(f"{DOCS_BY_FILE_PREFIX}{file_path}")
        return [
            dhash.decode() if isinstance(dhash, bytes) else dhash
            for dhash in doc_hashes
        ]

    async def delete_doc(self, doc_hash: str) -> bool:
        """Delete a doc from Redis."""
        if not self._available or not self._redis:
            return False

        # Get file path for cleanup
        meta = await self.get_doc_meta(doc_hash)
        file_path = meta.get("file_path", "") if meta else ""

        # Delete doc keys
        await self._redis.delete(
            f"{DOC_PREFIX}{doc_hash}:meta",
            f"{DOC_PREFIX}{doc_hash}:chunk",
            f"{DOC_PREFIX}{doc_hash}:embedding",
        )
        await self._redis.srem(DOCS_INDEX, doc_hash)

        # Remove from by-file index
        if file_path:
            await self._redis.srem(f"{DOCS_BY_FILE_PREFIX}{file_path}", doc_hash)

        return True

    # =========================================================================
    # Utilities
    # =========================================================================

    def _deserialize_embedding(self, data: bytes) -> np.ndarray:
        """Deserialize embedding from bytes."""
        count = len(data) // 4  # float32 is 4 bytes
        values = struct.unpack(f"{count}f", data)
        return np.array(values, dtype=np.float32)

    async def get_stats(self) -> Dict[str, Any]:
        """Get store statistics."""
        if not self._available or not self._redis:
            return {
                "available": False,
                "bundle_count": 0,
                "doc_count": 0,
                "indexed_files": 0,
            }

        bundle_ids = await self._redis.smembers(BUNDLES_INDEX)
        doc_hashes = await self._redis.smembers(DOCS_INDEX)
        last_sync = await self._redis.get(DOCS_LAST_SYNC)

        return {
            "available": True,
            "bundle_count": len(bundle_ids),
            "doc_count": len(doc_hashes),
            "indexed_files": len(await self.get_indexed_files()),
            "last_doc_sync": last_sync.decode() if last_sync and isinstance(last_sync, bytes) else last_sync,
        }

    async def clear_all(self) -> None:
        """Clear all knowledge store data. Use with caution."""
        if not self._available or not self._redis:
            return

        # Get all bundle and doc keys
        bundle_keys = await self._redis.keys(f"{BUNDLE_PREFIX}*")
        doc_keys = await self._redis.keys(f"{DOC_PREFIX}*")

        # Delete all keys
        all_keys = bundle_keys + doc_keys + [BUNDLES_INDEX, DOCS_INDEX, DOCS_LAST_SYNC]
        if all_keys:
            await self._redis.delete(*all_keys)

        logger.info("Cleared all knowledge store data")
