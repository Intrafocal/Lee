"""
Hester CLI - Crypto utilities for local development decryption.

Provides in-memory decryption of encrypted fields when querying local Supabase.
Only works with local Supabase (dev mode encryption - base64 DEKs, no KMS).
"""

import base64
import hashlib
import os
from typing import Any, Dict, List, Optional

from cryptography.hazmat.primitives.ciphers.aead import AESGCM


class LocalDecryptionError(Exception):
    """Error during local decryption."""
    pass


class LocalDecryptor:
    """
    Decrypts encrypted fields from local Supabase for development inspection.

    Only works with dev-mode encryption where DEKs are stored as plain base64
    (not KMS-protected). Will refuse to run against production URLs.
    """

    # Known encrypted column mappings: encrypted_col -> (plain_col, hash_col)
    ENCRYPTED_COLUMNS = {
        # Genome tables
        "encrypted_narrative": ("narrative", "narrative_hash"),
        "encrypted_marker_text": ("marker_text", "marker_text_hash"),
        "encrypted_description": ("description", "description_hash"),
        "encrypted_content": ("content", "content_hash"),
        # Sybil tables
        "encrypted_messages": ("messages", "messages_hash"),
        "encrypted_insight_data": ("insight_data", "insight_data_hash"),
        "encrypted_relationship_data": ("relationship_data", "relationship_data_hash"),
        "encrypted_company_context": ("company_context", "company_context_hash"),
        "encrypted_recommendation_data": ("recommendation_data", "recommendation_data_hash"),
        "encrypted_artifact_data": ("artifact_data", "artifact_data_hash"),
        # Scene tables
        "encrypted_scene_data": ("scene_data", "scene_data_hash"),
        "encrypted_completed_research": ("completed_research", "completed_research_hash"),
        "encrypted_active_tasks": ("active_tasks", "active_tasks_hash"),
        "encrypted_variant_delta": ("variant_delta", "variant_delta_hash"),
        # Network tables
        "encrypted_metadata": ("metadata", "metadata_hash"),
        "encrypted_circles": ("circles", "circles_hash"),
        "encrypted_relationship": ("relationship", "relationship_hash"),
        "encrypted_circle_name": ("circle_name", "circle_name_hash"),
        "encrypted_custom_prompt_text": ("custom_prompt_text", "custom_prompt_text_hash"),
        "encrypted_prompt_parameters": ("prompt_parameters", "prompt_parameters_hash"),
        # Agentic result tables
        "encrypted_result_data": ("result_data", "result_data_hash"),
        # Evidence/Pattern tables (decay views)
        "encrypted_observation": ("observation", "observation_hash"),
        "encrypted_pattern": ("pattern", "pattern_hash"),
        "encrypted_analysis": ("analysis", "analysis_hash"),
        # QA tables
        "encrypted_transcript": ("transcript", "transcript_hash"),
        "encrypted_evaluation": ("evaluation", "evaluation_hash"),
        # Ideas/Briefs tables
        "encrypted_raw_input": ("raw_input", "raw_input_hash"),
        "encrypted_context": ("context", "context_hash"),
        "encrypted_raw_sources": ("raw_sources", "raw_sources_hash"),
        # Integration secrets
        "encrypted_credentials": ("credentials", "credentials_hash"),
    }

    LOCAL_URL_PATTERNS = ["127.0.0.1", "localhost", "host.docker.internal"]

    def __init__(self, database_url: str):
        """
        Initialize the local decryptor.

        Args:
            database_url: PostgreSQL connection URL

        Raises:
            LocalDecryptionError: If URL doesn't look like local Supabase
        """
        self.database_url = database_url
        self._dek_cache: Dict[str, bytes] = {}  # user_id -> plaintext DEK

        # Verify local URL
        if not any(pattern in database_url.lower() for pattern in self.LOCAL_URL_PATTERNS):
            raise LocalDecryptionError(
                f"Decryption only works with local Supabase. "
                f"URL '{database_url}' doesn't look local."
            )

    async def get_user_deks(self, user_id: str, pool) -> List[bytes]:
        """
        Fetch and decode all active DEKs for a user from encryption_key_metadata.

        In dev mode, DEKs are stored as plain base64 (not KMS-encrypted).
        Since different data types use different DEKs, we return all of them
        so the caller can try each one.

        Args:
            user_id: Supabase auth user UUID
            pool: asyncpg connection pool

        Returns:
            List of 32-byte plaintext DEKs
        """
        cache_key = f"deks:{user_id}"
        if cache_key in self._dek_cache:
            return self._dek_cache[cache_key]

        async with pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT encrypted_dek, data_type
                FROM encryption_key_metadata
                WHERE user_id = $1 AND status = 'active'
                ORDER BY created_at DESC
                """,
                user_id
            )

            if not rows:
                raise LocalDecryptionError(
                    f"No active DEKs found for user {user_id}. "
                    "User may not have any encrypted data yet."
                )

            deks = []
            for row in rows:
                encrypted_dek_b64 = row["encrypted_dek"]

                # In dev mode, this is just base64-encoded plaintext DEK
                try:
                    dek = base64.b64decode(encrypted_dek_b64)
                except Exception:
                    continue  # Skip invalid DEKs

                # Validate DEK length (should be 32 bytes for AES-256)
                if len(dek) == 32:
                    deks.append(dek)

            if not deks:
                raise LocalDecryptionError(
                    f"No valid DEKs found for user {user_id}. "
                    "DEKs may be KMS-encrypted - decryption only works in dev mode."
                )

            self._dek_cache[cache_key] = deks
            return deks

    def decrypt_value_with_dek(
        self,
        ciphertext_b64: str,
        dek: bytes,
        expected_hash: Optional[str] = None
    ) -> Optional[str]:
        """
        Try to decrypt a value using a specific DEK.

        Args:
            ciphertext_b64: Base64-encoded ciphertext (nonce + ciphertext + tag)
            dek: 32-byte Data Encryption Key
            expected_hash: Optional SHA-256 hash for integrity verification

        Returns:
            Decrypted plaintext string, or None if decryption fails
        """
        try:
            # Decode base64
            ciphertext_with_nonce = base64.b64decode(ciphertext_b64)

            # Extract nonce (first 12 bytes for GCM)
            nonce = ciphertext_with_nonce[:12]
            ciphertext = ciphertext_with_nonce[12:]

            # Decrypt
            aesgcm = AESGCM(dek)
            plaintext_bytes = aesgcm.decrypt(nonce, ciphertext, None)

            # Verify hash if provided
            if expected_hash:
                calculated_hash = hashlib.sha256(plaintext_bytes).hexdigest()
                if calculated_hash != expected_hash:
                    return None  # Hash mismatch, try next DEK

            return plaintext_bytes.decode("utf-8")

        except Exception:
            return None  # Decryption failed, try next DEK

    def decrypt_value(
        self,
        ciphertext_b64: str,
        deks: List[bytes],
        expected_hash: Optional[str] = None
    ) -> str:
        """
        Decrypt a value by trying multiple DEKs until one works.

        Args:
            ciphertext_b64: Base64-encoded ciphertext (nonce + ciphertext + tag)
            deks: List of 32-byte Data Encryption Keys to try
            expected_hash: Optional SHA-256 hash for integrity verification

        Returns:
            Decrypted plaintext string, or error message if all DEKs fail
        """
        for dek in deks:
            result = self.decrypt_value_with_dek(ciphertext_b64, dek, expected_hash)
            if result is not None:
                return result

        return "[decrypt failed: no matching DEK]"

    async def decrypt_rows(
        self,
        rows: List[Dict[str, Any]],
        user_id: str,
        pool
    ) -> tuple[List[Dict[str, Any]], int]:
        """
        Decrypt encrypted fields in query result rows.

        Finds columns matching encrypted_* pattern, decrypts them, and renames
        to the plain column name (e.g., encrypted_narrative -> narrative).

        Args:
            rows: List of row dictionaries from query
            user_id: User ID for DEK lookup
            pool: asyncpg connection pool

        Returns:
            Tuple of (decrypted rows, count of fields decrypted)
        """
        if not rows:
            return rows, 0

        # Find encrypted columns in result set
        encrypted_cols = [k for k in rows[0].keys() if k.startswith("encrypted_")]

        if not encrypted_cols:
            return rows, 0

        # Get all DEKs for user (different data types use different DEKs)
        try:
            deks = await self.get_user_deks(user_id, pool)
        except LocalDecryptionError as e:
            # Return rows with error markers
            decrypted_rows = []
            for row in rows:
                new_row = dict(row)
                for col in encrypted_cols:
                    plain_col, _ = self.ENCRYPTED_COLUMNS.get(col, (col.replace("encrypted_", ""), None))
                    new_row[plain_col] = f"[{e}]"
                    del new_row[col]
                decrypted_rows.append(new_row)
            return decrypted_rows, 0

        # Decrypt each row
        decrypted_rows = []
        fields_decrypted = 0

        for row in rows:
            new_row = dict(row)

            for col in encrypted_cols:
                ciphertext = new_row.get(col)
                if not ciphertext:
                    # Remove encrypted column, add empty plain column
                    plain_col, _ = self.ENCRYPTED_COLUMNS.get(col, (col.replace("encrypted_", ""), None))
                    new_row[plain_col] = None
                    del new_row[col]
                    continue

                # Get hash column if it exists
                plain_col, hash_col = self.ENCRYPTED_COLUMNS.get(
                    col, (col.replace("encrypted_", ""), None)
                )
                expected_hash = new_row.get(hash_col) if hash_col else None

                # Decrypt (tries all DEKs until one works)
                plaintext = self.decrypt_value(ciphertext, deks, expected_hash)

                # Replace encrypted with decrypted
                new_row[plain_col] = plaintext
                del new_row[col]

                # Remove hash column from output (noise)
                if hash_col and hash_col in new_row:
                    del new_row[hash_col]

                fields_decrypted += 1

            decrypted_rows.append(new_row)

        return decrypted_rows, fields_decrypted


class LocalEncryptor:
    """
    Encrypts fields for writing back to local Supabase checkpoints.

    Counterpart to LocalDecryptor — uses existing DEKs to encrypt data
    in the same format that EncryptionService produces.

    Only works with local Supabase (dev mode).
    """

    LOCAL_URL_PATTERNS = LocalDecryptor.LOCAL_URL_PATTERNS

    def __init__(self, database_url: str):
        self.database_url = database_url

        if not any(pattern in database_url.lower() for pattern in self.LOCAL_URL_PATTERNS):
            raise LocalDecryptionError(
                f"Encryption only works with local Supabase. "
                f"URL '{database_url}' doesn't look local."
            )

    async def get_dek_for_data_type(
        self,
        user_id: str,
        data_type: str,
        pool,
    ) -> bytes:
        """Fetch the active DEK for a specific user + data_type.

        Args:
            user_id: Supabase auth user UUID
            data_type: e.g. "agentgraph_checkpoints"
            pool: asyncpg connection pool

        Returns:
            32-byte DEK

        Raises:
            LocalDecryptionError if no matching DEK found
        """
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                SELECT encrypted_dek
                FROM encryption_key_metadata
                WHERE user_id = $1 AND data_type = $2 AND status = 'active'
                ORDER BY created_at DESC
                LIMIT 1
                """,
                user_id,
                data_type,
            )

            if not row:
                raise LocalDecryptionError(
                    f"No active DEK found for user {user_id}, data_type={data_type}"
                )

            dek = base64.b64decode(row["encrypted_dek"])
            if len(dek) != 32:
                raise LocalDecryptionError(f"Invalid DEK length: {len(dek)} (expected 32)")

            return dek

    def encrypt_value(self, plaintext: str, dek: bytes) -> Dict[str, str]:
        """Encrypt a plaintext string using AES-256-GCM.

        Produces the same format as EncryptionService.encrypt_field:
        - ciphertext: base64(nonce + ciphertext + tag)
        - hash: SHA-256 hex digest of plaintext bytes
        - version: "v1"

        Args:
            plaintext: JSON string to encrypt
            dek: 32-byte AES key

        Returns:
            Dict with ciphertext, hash, version
        """
        plaintext_bytes = plaintext.encode("utf-8")

        nonce = os.urandom(12)
        aesgcm = AESGCM(dek)
        ciphertext = aesgcm.encrypt(nonce, plaintext_bytes, None)

        ciphertext_with_nonce = nonce + ciphertext
        ciphertext_b64 = base64.b64encode(ciphertext_with_nonce).decode("utf-8")
        hash_hex = hashlib.sha256(plaintext_bytes).hexdigest()

        return {
            "ciphertext": ciphertext_b64,
            "hash": hash_hex,
            "version": "v1",
        }


def is_local_database(url: str) -> bool:
    """Check if a database URL points to local Supabase."""
    return any(pattern in url.lower() for pattern in LocalDecryptor.LOCAL_URL_PATTERNS)
