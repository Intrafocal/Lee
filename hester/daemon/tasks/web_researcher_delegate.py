"""
Web Researcher Delegate - Web research with Google Search grounding.

This delegate provides research capabilities by using Gemini with Google Search
to synthesize information from the web and return structured responses with sources.
"""

import logging
import os
from typing import Any, Dict, List, Optional

logger = logging.getLogger("hester.daemon.tasks.web_researcher_delegate")

# Lazy-loaded client
_gemini_client = None


def _get_client():
    """Get or create the Gemini client."""
    global _gemini_client
    if _gemini_client is None:
        from google import genai
        _gemini_client = genai.Client()
    return _gemini_client


class WebResearcherDelegate:
    """
    Delegate for web research with Google Search grounding.

    Uses Gemini with Google Search to:
    - Research topics with up-to-date information
    - Synthesize answers from multiple sources
    - Return structured responses with source citations
    """

    def __init__(
        self,
        model: str = "gemini-2.5-flash",
        max_sources: int = 10,
        api_key: Optional[str] = None,
    ):
        """
        Initialize the delegate.

        Args:
            model: Gemini model to use
            max_sources: Maximum number of sources to include in response
            api_key: Google API key (defaults to GOOGLE_API_KEY env var)
        """
        # Verify API key exists
        api_key = api_key or os.environ.get("GOOGLE_API_KEY")
        if not api_key:
            raise ValueError("GOOGLE_API_KEY environment variable is required")

        self.model = model
        self.max_sources = max_sources

        logger.info(f"WebResearcherDelegate initialized: model={model}, max_sources={max_sources}")

    async def execute(
        self,
        prompt: str,
        context: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Execute a research query with Google Search grounding.

        Args:
            prompt: The research query
            context: Optional context to include in the query

        Returns:
            Dict with:
            - success: Whether the query succeeded
            - answer: The synthesized answer
            - sources: List of source dictionaries with title and uri
            - search_queries: What queries Gemini actually ran
            - confidence: Estimated confidence (based on source count)
        """
        try:
            from google.genai import types

            client = _get_client()

            # Build the full prompt with context if provided
            full_prompt = prompt
            if context:
                full_prompt = f"{context}\n\nQuestion: {prompt}"

            # Configure with Google Search grounding
            grounding_tool = types.Tool(google_search=types.GoogleSearch())
            config = types.GenerateContentConfig(tools=[grounding_tool])

            logger.info(f"Grounded research: {prompt[:100]}...")

            response = client.models.generate_content(
                model=self.model,
                contents=full_prompt,
                config=config,
            )

            answer = response.text if response.text else "No results found."

            # Extract grounding metadata
            sources: List[Dict[str, str]] = []
            search_queries: List[str] = []

            if hasattr(response, 'candidates') and response.candidates:
                candidate = response.candidates[0]
                if hasattr(candidate, 'grounding_metadata') and candidate.grounding_metadata:
                    metadata = candidate.grounding_metadata

                    # Extract search queries used
                    if hasattr(metadata, 'web_search_queries') and metadata.web_search_queries:
                        search_queries = list(metadata.web_search_queries)

                    # Extract sources
                    if hasattr(metadata, 'grounding_chunks') and metadata.grounding_chunks:
                        for chunk in metadata.grounding_chunks[:self.max_sources]:
                            if hasattr(chunk, 'web') and chunk.web:
                                sources.append({
                                    "title": getattr(chunk.web, 'title', ''),
                                    "uri": getattr(chunk.web, 'uri', ''),
                                })

            logger.info(f"Research complete: {len(sources)} sources, {len(search_queries)} queries")

            # Calculate confidence based on source coverage
            confidence = min(1.0, len(sources) / 3.0)  # 3+ sources = high confidence

            return {
                "success": True,
                "answer": answer,
                "sources": sources,
                "search_queries": search_queries,
                "confidence": confidence,
            }

        except Exception as e:
            logger.error(f"Grounded research error: {e}")
            return {
                "success": False,
                "answer": f"Research failed: {e}",
                "sources": [],
                "search_queries": [],
                "confidence": 0.0,
                "error": str(e),
            }

    async def execute_batch(
        self,
        batch: "TaskBatch",
        context: str = "",
    ) -> Dict[str, Any]:
        """
        Execute a batch using this delegate.

        This method is called by TaskExecutor for web_researcher batches.

        Args:
            batch: The batch to execute
            context: Context from previous batches

        Returns:
            Dict with success, output, and optional summary
        """
        from .models import TaskBatch

        # Execute the research query
        result = await self.execute(
            prompt=batch.prompt,
            context=context if context else None,
        )

        # Format output with sources
        output_lines = [result.get("answer", "")]

        sources = result.get("sources", [])
        if sources:
            output_lines.append("\n\n## Sources")
            for src in sources:
                if src.get("uri"):
                    title = src.get("title", "Link")
                    output_lines.append(f"- [{title}]({src['uri']})")

        search_queries = result.get("search_queries", [])
        if search_queries:
            output_lines.append(f"\n\n*Search queries: {', '.join(search_queries)}*")

        output = "\n".join(output_lines)

        # Create summary for context chaining
        summary = result.get("answer", "")
        if len(summary) > 500:
            summary = summary[:500] + "..."

        return {
            "success": result.get("success", False),
            "output": output,
            "summary": summary,
            "sources": sources,
            "confidence": result.get("confidence", 0.0),
        }


def format_grounded_result(result: Dict[str, Any]) -> str:
    """Format a grounded research result for display."""
    if result.get("error"):
        return f"Research error: {result['error']}"

    lines = [result.get("answer", "")]

    sources = result.get("sources", [])
    if sources:
        lines.append("\n**Sources:**")
        for src in sources:
            if src.get("uri"):
                title = src.get("title", "Link")
                lines.append(f"- [{title}]({src['uri']})")

    return "\n".join(lines)
