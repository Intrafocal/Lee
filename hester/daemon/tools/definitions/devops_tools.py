"""
DevOps tool definitions - service management, docker, compose.
"""

from .models import ToolDefinition

# All devops tools require local service/docker access - not available in slack
_DEVOPS_ENVIRONMENTS = {"daemon", "cli", "subagent"}


DEVOPS_LIST_SERVICES_TOOL = ToolDefinition(
    name="devops_list_services",
    description="""List all configured services from the workspace config.
Shows services defined in .lee/config.yaml with their current status.
Returns service names, commands, ports, and running state.

Examples:
- devops_list_services() - list all configured services
- devops_list_services(environment="Local Dev") - list services in specific environment""",
    parameters={
        "type": "object",
        "properties": {
            "environment": {
                "type": "string",
                "description": "Filter by environment name (default: all environments)",
            },
        },
        "required": [],
    },
    environments=_DEVOPS_ENVIRONMENTS,
)

DEVOPS_START_SERVICE_TOOL = ToolDefinition(
    name="devops_start_service",
    description="""Start a configured service.
Launches the service in background and returns the process ID.
The service must be defined in .lee/config.yaml.

Examples:
- devops_start_service(service_name="API Gateway") - start the API Gateway
- devops_start_service(service_name="Redis", environment="Local Dev")""",
    parameters={
        "type": "object",
        "properties": {
            "service_name": {
                "type": "string",
                "description": "Name of the service to start (as defined in config)",
            },
            "environment": {
                "type": "string",
                "description": "Environment name (default: first matching service)",
            },
        },
        "required": ["service_name"],
    },
    environments=_DEVOPS_ENVIRONMENTS,
)

DEVOPS_STOP_SERVICE_TOOL = ToolDefinition(
    name="devops_stop_service",
    description="""Stop a running service.
Sends SIGTERM to gracefully stop the service.

Examples:
- devops_stop_service(service_name="API Gateway") - stop the API Gateway
- devops_stop_service(service_name="All Services") - stop all services in environment""",
    parameters={
        "type": "object",
        "properties": {
            "service_name": {
                "type": "string",
                "description": "Name of the service to stop",
            },
            "environment": {
                "type": "string",
                "description": "Environment name (default: first matching service)",
            },
        },
        "required": ["service_name"],
    },
    environments=_DEVOPS_ENVIRONMENTS,
)

DEVOPS_SERVICE_STATUS_TOOL = ToolDefinition(
    name="devops_service_status",
    description="""Get detailed status of a service.
Shows running state, PID, port, uptime, and recent logs.

Examples:
- devops_service_status(service_name="API Gateway") - get API Gateway status
- devops_service_status(service_name="Redis") - check if Redis is running""",
    parameters={
        "type": "object",
        "properties": {
            "service_name": {
                "type": "string",
                "description": "Name of the service to check",
            },
            "environment": {
                "type": "string",
                "description": "Environment name",
            },
        },
        "required": ["service_name"],
    },
    environments=_DEVOPS_ENVIRONMENTS,
)

DEVOPS_SERVICE_LOGS_TOOL = ToolDefinition(
    name="devops_service_logs",
    description="""Get logs from a running service.
Returns recent stdout/stderr output from the service process.

Examples:
- devops_service_logs(service_name="API Gateway") - get last 50 lines
- devops_service_logs(service_name="Django Frontend", lines=100) - get last 100 lines
- devops_service_logs(service_name="Matching Service", follow=true) - stream new logs""",
    parameters={
        "type": "object",
        "properties": {
            "service_name": {
                "type": "string",
                "description": "Name of the service",
            },
            "environment": {
                "type": "string",
                "description": "Environment name",
            },
            "lines": {
                "type": "integer",
                "description": "Number of lines to return (default: 50)",
            },
        },
        "required": ["service_name"],
    },
    environments=_DEVOPS_ENVIRONMENTS,
)

DEVOPS_HEALTH_CHECK_TOOL = ToolDefinition(
    name="devops_health_check",
    description="""Run health checks on services.
Checks if services are responding on their configured ports/endpoints.
Returns health status for each service with response times.

Examples:
- devops_health_check() - check all services with health_check configured
- devops_health_check(service_name="API Gateway") - check specific service
- devops_health_check(environment="Local Dev") - check all in environment""",
    parameters={
        "type": "object",
        "properties": {
            "service_name": {
                "type": "string",
                "description": "Specific service to check (default: all)",
            },
            "environment": {
                "type": "string",
                "description": "Environment name",
            },
        },
        "required": [],
    },
    environments=_DEVOPS_ENVIRONMENTS,
)

DEVOPS_DOCKER_STATUS_TOOL = ToolDefinition(
    name="devops_docker_status",
    description="""Get Docker container status.
Lists running containers with their status, ports, and resource usage.

Examples:
- devops_docker_status() - list all containers
- devops_docker_status(filter="myapp") - filter by name
- devops_docker_status(all=true) - include stopped containers""",
    parameters={
        "type": "object",
        "properties": {
            "filter": {
                "type": "string",
                "description": "Filter containers by name (partial match)",
            },
            "all": {
                "type": "boolean",
                "description": "Include stopped containers (default: false)",
            },
        },
        "required": [],
    },
    environments=_DEVOPS_ENVIRONMENTS,
)

DEVOPS_DOCKER_LOGS_TOOL = ToolDefinition(
    name="devops_docker_logs",
    description="""Get logs from a Docker container.
Returns recent logs from the specified container.

Examples:
- devops_docker_logs(container="myapp-api-1") - get container logs
- devops_docker_logs(container="redis", lines=100) - get last 100 lines""",
    parameters={
        "type": "object",
        "properties": {
            "container": {
                "type": "string",
                "description": "Container name or ID",
            },
            "lines": {
                "type": "integer",
                "description": "Number of lines to return (default: 50)",
            },
        },
        "required": ["container"],
    },
    environments=_DEVOPS_ENVIRONMENTS,
)

DEVOPS_COMPOSE_UP_TOOL = ToolDefinition(
    name="devops_compose_up",
    description="""Start Docker Compose services.
Use this to start one or more services defined in docker-compose.yaml.

Examples:
- devops_compose_up() - start all services
- devops_compose_up(services=["api", "agentic"]) - start specific services
- devops_compose_up(build=True) - build images before starting
- devops_compose_up(no_cache=True) - rebuild without cache
- devops_compose_up(detach=True) - run in background""",
    parameters={
        "type": "object",
        "properties": {
            "services": {
                "type": "array",
                "items": {"type": "string"},
                "description": "List of service names to start (default: all)",
            },
            "build": {
                "type": "boolean",
                "description": "Build images before starting (default: false)",
            },
            "no_cache": {
                "type": "boolean",
                "description": "Build without cache (default: false)",
            },
            "detach": {
                "type": "boolean",
                "description": "Run in detached mode (default: true for daemon)",
            },
        },
        "required": [],
    },
    environments=_DEVOPS_ENVIRONMENTS,
)

DEVOPS_COMPOSE_DOWN_TOOL = ToolDefinition(
    name="devops_compose_down",
    description="""Stop and remove Docker Compose services.
Use this to stop running services and clean up containers.

Examples:
- devops_compose_down() - stop all services
- devops_compose_down(volumes=True) - also remove volumes
- devops_compose_down(rmi="all") - also remove images""",
    parameters={
        "type": "object",
        "properties": {
            "volumes": {
                "type": "boolean",
                "description": "Remove volumes (default: false)",
            },
            "rmi": {
                "type": "string",
                "enum": ["all", "local"],
                "description": "Remove images: 'all' or 'local' (default: none)",
            },
        },
        "required": [],
    },
    environments=_DEVOPS_ENVIRONMENTS,
)

DEVOPS_COMPOSE_BUILD_TOOL = ToolDefinition(
    name="devops_compose_build",
    description="""Build Docker Compose images.
Use this to build images without starting services.

Examples:
- devops_compose_build() - build all images
- devops_compose_build(services=["api"]) - build specific service
- devops_compose_build(no_cache=True) - build without cache""",
    parameters={
        "type": "object",
        "properties": {
            "services": {
                "type": "array",
                "items": {"type": "string"},
                "description": "List of service names to build (default: all)",
            },
            "no_cache": {
                "type": "boolean",
                "description": "Build without cache (default: false)",
            },
        },
        "required": [],
    },
    environments=_DEVOPS_ENVIRONMENTS,
)

DEVOPS_COMPOSE_REBUILD_TOOL = ToolDefinition(
    name="devops_compose_rebuild",
    description="""Rebuild and restart Docker Compose services.
Shortcut for: down + build + up. Use this when you need a fresh restart.

Examples:
- devops_compose_rebuild() - rebuild all services
- devops_compose_rebuild(services=["api"]) - rebuild specific service
- devops_compose_rebuild(no_cache=True) - full rebuild without cache""",
    parameters={
        "type": "object",
        "properties": {
            "services": {
                "type": "array",
                "items": {"type": "string"},
                "description": "List of service names to rebuild (default: all)",
            },
            "no_cache": {
                "type": "boolean",
                "description": "Build without cache (default: false)",
            },
        },
        "required": [],
    },
    environments=_DEVOPS_ENVIRONMENTS,
)

DEVOPS_COMPOSE_PS_TOOL = ToolDefinition(
    name="devops_compose_ps",
    description="""Show Docker Compose service status.
Lists all services and their current state.

Examples:
- devops_compose_ps() - show all service status""",
    parameters={
        "type": "object",
        "properties": {},
        "required": [],
    },
    environments=_DEVOPS_ENVIRONMENTS,
)

DEVOPS_COMPOSE_LOGS_TOOL = ToolDefinition(
    name="devops_compose_logs",
    description="""Get logs from Docker Compose services.
Returns logs from one or more services.

Examples:
- devops_compose_logs(services=["api"]) - get API logs
- devops_compose_logs(services=["api", "agentic"], lines=100) - get multiple service logs""",
    parameters={
        "type": "object",
        "properties": {
            "services": {
                "type": "array",
                "items": {"type": "string"},
                "description": "List of service names (default: all)",
            },
            "lines": {
                "type": "integer",
                "description": "Number of lines per service (default: 50)",
            },
        },
        "required": [],
    },
    environments=_DEVOPS_ENVIRONMENTS,
)


# All DevOps tools
DEVOPS_TOOLS = [
    DEVOPS_LIST_SERVICES_TOOL,
    DEVOPS_START_SERVICE_TOOL,
    DEVOPS_STOP_SERVICE_TOOL,
    DEVOPS_SERVICE_STATUS_TOOL,
    DEVOPS_SERVICE_LOGS_TOOL,
    DEVOPS_HEALTH_CHECK_TOOL,
    DEVOPS_DOCKER_STATUS_TOOL,
    DEVOPS_DOCKER_LOGS_TOOL,
    DEVOPS_COMPOSE_UP_TOOL,
    DEVOPS_COMPOSE_DOWN_TOOL,
    DEVOPS_COMPOSE_BUILD_TOOL,
    DEVOPS_COMPOSE_REBUILD_TOOL,
    DEVOPS_COMPOSE_PS_TOOL,
    DEVOPS_COMPOSE_LOGS_TOOL,
]
