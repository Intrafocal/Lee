"""
Web Search Tool - Google Search grounding via Gemini.

Provides real-time web search capabilities for current information.
"""

import logging
from typing import Any, Dict, List, Optional

logger = logging.getLogger("hester.daemon.tools.web_search")

# Lazy-loaded client
_gemini_client = None


def _get_client():
    """Get or create the Gemini client."""
    global _gemini_client
    if _gemini_client is None:
        from google import genai
        _gemini_client = genai.Client()
    return _gemini_client


async def web_search(
    query: str,
    model: str = "gemini-2.5-flash",
    max_sources: int = 5,
) -> Dict[str, Any]:
    """
    Search the web using Google Search grounding via Gemini.

    Args:
        query: The search query
        model: Gemini model to use (default: gemini-2.5-flash)
        max_sources: Maximum number of sources to include (default: 5)

    Returns:
        Dict with:
        - content: The search result text
        - sources: List of source URLs with titles
        - search_queries: What queries Gemini actually ran
        - error: Error message if failed
    """
    try:
        from google.genai import types

        client = _get_client()

        # Configure with Google Search grounding
        grounding_tool = types.Tool(google_search=types.GoogleSearch())
        config = types.GenerateContentConfig(tools=[grounding_tool])

        logger.info(f"Web search: {query}")

        response = client.models.generate_content(
            model=model,
            contents=query,
            config=config,
        )

        result_text = response.text if response.text else "No results found."

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
                    for chunk in metadata.grounding_chunks[:max_sources]:
                        if hasattr(chunk, 'web') and chunk.web:
                            sources.append({
                                "title": getattr(chunk.web, 'title', ''),
                                "uri": getattr(chunk.web, 'uri', ''),
                            })

        logger.info(f"Web search complete: {len(sources)} sources")

        return {
            "content": result_text,
            "sources": sources,
            "search_queries": search_queries,
        }

    except Exception as e:
        logger.error(f"Web search error: {e}")
        return {
            "content": "",
            "sources": [],
            "search_queries": [],
            "error": str(e),
        }


def format_search_result(result: Dict[str, Any]) -> str:
    """Format a search result for display."""
    if result.get("error"):
        return f"Search error: {result['error']}"

    lines = [result.get("content", "")]

    sources = result.get("sources", [])
    if sources:
        lines.append("\n**Sources:**")
        for src in sources:
            if src.get("uri"):
                title = src.get("title", "Link")
                lines.append(f"- [{title}]({src['uri']})")

    return "\n".join(lines)
