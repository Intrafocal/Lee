"""
Visualization tool definitions - Mermaid diagrams, Gemini image gen, structured markdown.
"""

from .models import ToolDefinition


RENDER_MERMAID_TOOL = ToolDefinition(
    name="render_mermaid",
    description="""Render a Mermaid diagram from a Mermaid DSL string.

Output the diagram definition in standard Mermaid syntax. The frontend will render
it as an SVG. Use this for structured diagrams: flowcharts, sequence diagrams,
class diagrams, state diagrams, Gantt charts, mind maps, etc.

Return the Mermaid code in the `mermaid` parameter. Do NOT wrap it in markdown fences.

Examples:
- Flowchart: render_mermaid(mermaid="graph TD\\n  A[Start] --> B{Decision}\\n  B -->|Yes| C[Action]\\n  B -->|No| D[End]", title="Decision Flow")
- Sequence: render_mermaid(mermaid="sequenceDiagram\\n  User->>API: Request\\n  API->>DB: Query\\n  DB-->>API: Result\\n  API-->>User: Response", title="API Flow")
- Mind map: render_mermaid(mermaid="mindmap\\n  root((Topic))\\n    Branch 1\\n      Detail A\\n    Branch 2\\n      Detail B", title="Topic Map")""",
    parameters={
        "type": "object",
        "properties": {
            "mermaid": {
                "type": "string",
                "description": "Mermaid diagram definition (raw DSL, not wrapped in code fences)",
            },
            "title": {
                "type": "string",
                "description": "Title for the diagram",
            },
        },
        "required": ["mermaid"],
    },
)

GENERATE_IMAGE_TOOL = ToolDefinition(
    name="generate_image",
    description="""Generate an image using Gemini's image generation capabilities.

Use this for freeform visual content that doesn't fit structured diagram formats:
concept art, visual metaphors, infographics, illustrations, abstract visualizations.

The prompt should describe what you want to see. Be specific about layout,
colors, style, and content. The image will be returned as base64 PNG.

Examples:
- generate_image(prompt="A clean infographic showing the relationship between 3 concepts: Speed, Quality, Cost. Triangle layout, modern flat design, dark background", title="Iron Triangle")
- generate_image(prompt="A visual timeline showing 5 milestones, left to right, with icons and dates, minimalist style", title="Project Timeline")""",
    parameters={
        "type": "object",
        "properties": {
            "prompt": {
                "type": "string",
                "description": "Description of the image to generate",
            },
            "title": {
                "type": "string",
                "description": "Title for the generated image",
            },
        },
        "required": ["prompt"],
    },
)

RENDER_MARKDOWN_TOOL = ToolDefinition(
    name="render_markdown",
    description="""Render structured text content as formatted markdown.

Use this for text-based visualizations: comparison tables, ASCII diagrams,
structured summaries, decision matrices, pros/cons lists, formatted hierarchies.

The markdown will be rendered with full GitHub-flavored markdown support
including tables, task lists, and code blocks.

Examples:
- render_markdown(markdown="| Feature | Option A | Option B |\\n|---------|----------|----------|\\n| Speed | Fast | Slow |\\n| Cost | High | Low |", title="Feature Comparison")
- render_markdown(markdown="## Key Findings\\n\\n1. **Finding One** — detail\\n2. **Finding Two** — detail\\n\\n> Important conclusion", title="Analysis Results")""",
    parameters={
        "type": "object",
        "properties": {
            "markdown": {
                "type": "string",
                "description": "Markdown content to render",
            },
            "title": {
                "type": "string",
                "description": "Title for the rendered content",
            },
        },
        "required": ["markdown"],
    },
)


# All visualization tools
VISUALIZATION_TOOLS = [
    RENDER_MERMAID_TOOL,
    GENERATE_IMAGE_TOOL,
    RENDER_MARKDOWN_TOOL,
]
