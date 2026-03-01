"""
Workstream Telemetry - Event models for workstream-scoped tracking.
"""

import uuid
from datetime import datetime
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class WorkstreamEvent(BaseModel):
    """A telemetry event within a Workstream context."""
    id: str = Field(default_factory=lambda: f"evt-{uuid.uuid4().hex[:8]}")
    timestamp: datetime = Field(default_factory=datetime.utcnow)
    workstream_id: str
    agent_session_id: str
    task_id: Optional[str] = None
    batch_id: Optional[str] = None
    event_type: str  # task_started, task_completed, tool_call, etc.
    tool_name: Optional[str] = None
    file_path: Optional[str] = None
    content_preview: Optional[str] = None
    duration_ms: Optional[int] = None
    success: Optional[bool] = None
    metadata: Dict[str, Any] = Field(default_factory=dict)
