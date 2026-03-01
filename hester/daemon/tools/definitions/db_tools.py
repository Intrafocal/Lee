"""
Database tool definitions - table listing, queries, constraints.
"""

from .models import ToolDefinition


DB_LIST_TABLES_TOOL = ToolDefinition(
    name="db_list_tables",
    description="""List all tables in the database with their schema information.
Returns all user-defined tables (excludes system tables) with schema, name, and owner.
Useful for database exploration and understanding the available data structures.

Examples:
- db_list_tables() - get overview of all tables""",
    parameters={
        "type": "object",
        "properties": {},
        "required": [],
    },
)

DB_DESCRIBE_TABLE_TOOL = ToolDefinition(
    name="db_describe_table",
    description="""Describe the structure of a specific table including columns, types, and indexes.
Use before writing queries to understand column types and constraints.

Examples:
- db_describe_table(table_name="users") - describe users table in public schema
- db_describe_table(table_name="orders", schema_name="sales") - describe orders table in sales schema""",
    parameters={
        "type": "object",
        "properties": {
            "table_name": {
                "type": "string",
                "description": "Name of the table to describe",
            },
            "schema_name": {
                "type": "string",
                "description": "Schema containing the table (default: 'public')",
            },
        },
        "required": ["table_name"],
    },
)

DB_LIST_FUNCTIONS_TOOL = ToolDefinition(
    name="db_list_functions",
    description="""List functions and procedures in the specified schema.
Useful for discovering available stored procedures and custom functions.

Examples:
- db_list_functions() - list all functions in public schema
- db_list_functions(schema_name="analytics") - list functions in analytics schema
- db_list_functions(query="user") - find functions with 'user' in the name""",
    parameters={
        "type": "object",
        "properties": {
            "schema_name": {
                "type": "string",
                "description": "Schema to search for functions (default: 'public')",
            },
            "query": {
                "type": "string",
                "description": "Optional string to filter function names (case-insensitive)",
            },
        },
        "required": [],
    },
)

DB_LIST_RLS_POLICIES_TOOL = ToolDefinition(
    name="db_list_rls_policies",
    description="""List Row Level Security (RLS) policies for a specific table.
Useful for security auditing and understanding data access controls.

Examples:
- db_list_rls_policies(table_name="users") - check RLS policies on users table
- db_list_rls_policies(table_name="orders", schema_name="sales") - check policies in sales schema""",
    parameters={
        "type": "object",
        "properties": {
            "table_name": {
                "type": "string",
                "description": "Name of the table to check for RLS policies",
            },
            "schema_name": {
                "type": "string",
                "description": "Schema containing the table (default: 'public')",
            },
        },
        "required": ["table_name"],
    },
)

DB_LIST_CONSTRAINTS_TOOL = ToolDefinition(
    name="db_list_constraints",
    description="""List all constraints on columns for a specific table.
Returns primary keys, foreign keys, unique constraints, check constraints, and not null columns.
Useful for understanding data integrity rules and relationships.

Examples:
- db_list_constraints(table_name="users") - get all constraints on users table
- db_list_constraints(table_name="orders", schema_name="sales") - constraints in sales schema""",
    parameters={
        "type": "object",
        "properties": {
            "table_name": {
                "type": "string",
                "description": "Name of the table to check for column constraints",
            },
            "schema_name": {
                "type": "string",
                "description": "Schema containing the table (default: 'public')",
            },
        },
        "required": ["table_name"],
    },
)

DB_EXECUTE_SELECT_TOOL = ToolDefinition(
    name="db_execute_select",
    description="""Execute a SELECT query with automatic row limiting for safe data exploration.
Only SELECT statements allowed. LIMIT is added automatically (max 25 rows).

Examples:
- db_execute_select(query="SELECT * FROM users", limit=5) - get first 5 users
- db_execute_select(query="SELECT name, email FROM customers WHERE active = true", limit=15)
- db_execute_select(query="SELECT COUNT(*) FROM orders") - get count

Note: Do not include LIMIT in your query - it will be added automatically.""",
    parameters={
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "SELECT statement (no LIMIT clause - will be added automatically)",
            },
            "limit": {
                "type": "integer",
                "description": "Maximum rows to return (1-25, default: 10)",
            },
        },
        "required": ["query"],
    },
)

DB_COUNT_ROWS_TOOL = ToolDefinition(
    name="db_count_rows",
    description="""Count rows in a table with optional filtering via WHERE clause.

Examples:
- db_count_rows(table_name="users") - total count of all users
- db_count_rows(table_name="products", where_clause="active = true") - count active products
- db_count_rows(table_name="transactions", where_clause="amount > 100") - conditional count

Note: Do not include 'WHERE' in the where_clause - it will be added automatically.""",
    parameters={
        "type": "object",
        "properties": {
            "table_name": {
                "type": "string",
                "description": "Name of the table to count",
            },
            "schema_name": {
                "type": "string",
                "description": "Schema containing the table (default: 'public')",
            },
            "where_clause": {
                "type": "string",
                "description": "Optional WHERE conditions (without the 'WHERE' keyword)",
            },
        },
        "required": ["table_name"],
    },
)


# All database tools
DB_TOOLS = [
    DB_LIST_TABLES_TOOL,
    DB_DESCRIBE_TABLE_TOOL,
    DB_LIST_FUNCTIONS_TOOL,
    DB_LIST_RLS_POLICIES_TOOL,
    DB_LIST_CONSTRAINTS_TOOL,
    DB_EXECUTE_SELECT_TOOL,
    DB_COUNT_ROWS_TOOL,
]
