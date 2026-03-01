import os
import re
from typing import Any, Dict, List, Optional
import asyncpg
from fastmcp import FastMCP
from pydantic import BaseModel

mcp = FastMCP("PostgreSQL MCP Server")

class DatabaseConnection:
    def __init__(self):
        self.pool: Optional[asyncpg.Pool] = None
    
    async def initialize(self):
        """Initialize the database connection pool"""
        host = os.getenv("POSTGRES_HOST", "localhost")
        port = int(os.getenv("POSTGRES_PORT", "5432"))
        database = os.getenv("POSTGRES_DATABASE")
        user = os.getenv("POSTGRES_USER")
        password = os.getenv("POSTGRES_PASSWORD")
        
        if not all([database, user]):
            raise ValueError("POSTGRES_DATABASE and POSTGRES_USER environment variables are required")
        
        self.pool = await asyncpg.create_pool(
            host=host,
            port=port,
            database=database,
            user=user,
            password=password,
            min_size=1,
            max_size=5
        )
    
    async def close(self):
        """Close the database connection pool"""
        if self.pool:
            await self.pool.close()

db = DatabaseConnection()

@mcp.tool()
async def list_tables() -> List[Dict[str, Any]]:
    """List all tables in the database with their schema information.
    
    Returns all user-defined tables (excludes system tables) with schema, name, and owner.
    Useful for database exploration and understanding the available data structures.
    
    Example usage:
    - Get overview of all tables in the database
    - Identify which schema contains specific tables
    - See table ownership information
    """
    if not db.pool:
        await db.initialize()
    
    async with db.pool.acquire() as conn:
        rows = await conn.fetch("""
            SELECT schemaname, tablename, tableowner
            FROM pg_tables
            WHERE schemaname NOT IN ('information_schema', 'pg_catalog')
            ORDER BY schemaname, tablename
        """)
        
        return [dict(row) for row in rows]

@mcp.tool()
async def describe_table(table_name: str, schema_name: str = "public") -> Dict[str, Any]:
    """Describe the structure of a specific table including columns, types, and indexes.
    
    Args:
        table_name: Name of the table to describe
        schema_name: Schema containing the table (defaults to 'public')
    
    Returns detailed information about:
    - Column names, data types, nullability, defaults
    - Numeric precision/scale for numeric columns
    - Character limits for text columns
    - All indexes on the table
    
    Example usage:
    - describe_table('users') - describe users table in public schema
    - describe_table('orders', 'sales') - describe orders table in sales schema
    - Use before writing queries to understand column types and constraints
    """
    if not db.pool:
        await db.initialize()
    
    async with db.pool.acquire() as conn:
        columns = await conn.fetch("""
            SELECT 
                column_name,
                data_type,
                is_nullable,
                column_default,
                character_maximum_length,
                numeric_precision,
                numeric_scale
            FROM information_schema.columns
            WHERE table_name = $1 AND table_schema = $2
            ORDER BY ordinal_position
        """, table_name, schema_name)
        
        indexes = await conn.fetch("""
            SELECT 
                i.indexname,
                i.indexdef,
                array_agg(a.attname ORDER BY a.attnum) as column_names
            FROM pg_indexes i
            JOIN pg_class c ON c.relname = i.indexname
            JOIN pg_index idx ON idx.indexrelid = c.oid
            JOIN pg_attribute a ON a.attrelid = idx.indrelid AND a.attnum = ANY(idx.indkey)
            WHERE i.tablename = $1 AND i.schemaname = $2
            GROUP BY i.indexname, i.indexdef
        """, table_name, schema_name)
        
        return {
            "table_name": table_name,
            "schema_name": schema_name,
            "columns": [dict(col) for col in columns],
            "indexes": [dict(idx) for idx in indexes]
        }

@mcp.tool()
async def list_functions(schema_name: str = "public", query: str = "") -> List[Dict[str, Any]]:
    """List functions and procedures in the specified schema with optional name filtering.
    
    Args:
        schema_name: Schema to search for functions (defaults to 'public')
        query: Optional string to filter function names (case-insensitive partial match)
    
    Returns information about:
    - Function names and types (FUNCTION vs PROCEDURE)
    - Return types for functions
    - Function definitions (source code)
    
    Example usage:
    - list_functions() - list all functions in public schema
    - list_functions('analytics') - list functions in analytics schema
    - list_functions(query='user') - find functions with 'user' in the name
    - list_functions('public', 'calculate') - find functions containing 'calculate' in public schema
    - Useful for discovering available stored procedures and custom functions
    """
    if not db.pool:
        await db.initialize()
    
    async with db.pool.acquire() as conn:
        if query.strip():
            rows = await conn.fetch("""
                SELECT 
                    routine_name as function_name,
                    routine_type,
                    data_type as return_type,
                    routine_definition
                FROM information_schema.routines
                WHERE routine_schema = $1 AND routine_name ILIKE $2
                ORDER BY routine_name
            """, schema_name, f"%{query}%")
        else:
            rows = await conn.fetch("""
                SELECT 
                    routine_name as function_name,
                    routine_type,
                    data_type as return_type,
                    routine_definition
                FROM information_schema.routines
                WHERE routine_schema = $1
                ORDER BY routine_name
            """, schema_name)
        
        return [dict(row) for row in rows]

@mcp.tool()
async def list_rls_policies(table_name: str, schema_name: str = "public") -> Dict[str, Any]:
    """List Row Level Security (RLS) policies for a specific table.
    
    Args:
        table_name: Name of the table to check for RLS policies
        schema_name: Schema containing the table (defaults to 'public')
    
    Returns information about:
    - Policy names and commands (SELECT, INSERT, UPDATE, DELETE, ALL)
    - Policy expressions (USING and WITH CHECK clauses)
    - Roles the policy applies to
    - Whether RLS is enabled on the table
    
    Example usage:
    - list_rls_policies('users') - check RLS policies on users table
    - list_rls_policies('orders', 'sales') - check policies in sales schema
    - Useful for security auditing and understanding data access controls
    """
    if not db.pool:
        await db.initialize()
    
    async with db.pool.acquire() as conn:
        # Check if RLS is enabled on the table
        rls_status = await conn.fetchval("""
            SELECT relrowsecurity
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relname = $1 AND n.nspname = $2
        """, table_name, schema_name)
        
        # Get all policies for the table
        policies = await conn.fetch("""
            SELECT 
                pol.polname as policy_name,
                pol.polcmd as command,
                pg_get_expr(pol.polqual, pol.polrelid) as using_expression,
                pg_get_expr(pol.polwithcheck, pol.polrelid) as with_check_expression,
                CASE 
                    WHEN pol.polroles = '{0}' THEN 'PUBLIC'
                    ELSE array_to_string(ARRAY(
                        SELECT rolname FROM pg_roles WHERE oid = ANY(pol.polroles)
                    ), ', ')
                END as roles
            FROM pg_policy pol
            JOIN pg_class c ON c.oid = pol.polrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relname = $1 AND n.nspname = $2
            ORDER BY pol.polname
        """, table_name, schema_name)
        
        return {
            "table": f"{schema_name}.{table_name}",
            "rls_enabled": bool(rls_status),
            "policies": [dict(policy) for policy in policies]
        }

@mcp.tool()
async def list_column_constraints(table_name: str, schema_name: str = "public") -> Dict[str, Any]:
    """List all constraints on columns for a specific table.
    
    Args:
        table_name: Name of the table to check for column constraints
        schema_name: Schema containing the table (defaults to 'public')
    
    Returns information about:
    - Primary key constraints
    - Foreign key constraints with referenced tables
    - Unique constraints
    - Check constraints with expressions
    - Not null constraints
    
    Example usage:
    - list_column_constraints('users') - get all constraints on users table
    - list_column_constraints('orders', 'sales') - constraints in sales schema
    - Useful for understanding data integrity rules and relationships
    """
    if not db.pool:
        await db.initialize()
    
    async with db.pool.acquire() as conn:
        constraints = await conn.fetch("""
            SELECT 
                tc.constraint_name,
                tc.constraint_type,
                kcu.column_name,
                CASE 
                    WHEN tc.constraint_type = 'FOREIGN KEY' THEN
                        ccu.table_schema || '.' || ccu.table_name || '.' || ccu.column_name
                    ELSE NULL
                END as foreign_key_reference,
                CASE 
                    WHEN tc.constraint_type = 'CHECK' THEN
                        cc.check_clause
                    ELSE NULL
                END as check_expression
            FROM information_schema.table_constraints tc
            LEFT JOIN information_schema.key_column_usage kcu
                ON tc.constraint_name = kcu.constraint_name
                AND tc.table_schema = kcu.table_schema
            LEFT JOIN information_schema.constraint_column_usage ccu
                ON tc.constraint_name = ccu.constraint_name
                AND tc.table_schema = ccu.constraint_schema
            LEFT JOIN information_schema.check_constraints cc
                ON tc.constraint_name = cc.constraint_name
                AND tc.table_schema = cc.constraint_schema
            WHERE tc.table_name = $1 AND tc.table_schema = $2
            ORDER BY tc.constraint_type, tc.constraint_name, kcu.ordinal_position
        """, table_name, schema_name)
        
        # Also get NOT NULL constraints from column info
        not_null_columns = await conn.fetch("""
            SELECT column_name
            FROM information_schema.columns
            WHERE table_name = $1 AND table_schema = $2 AND is_nullable = 'NO'
            ORDER BY ordinal_position
        """, table_name, schema_name)
        
        return {
            "table": f"{schema_name}.{table_name}",
            "constraints": [dict(constraint) for constraint in constraints],
            "not_null_columns": [row['column_name'] for row in not_null_columns]
        }

def validate_select_query(query: str) -> bool:
    """Validate that the query is a safe SELECT statement"""
    query_clean = query.strip().lower()
    
    if not query_clean.startswith('select'):
        return False
    
    # More precise keyword detection using word boundaries
    forbidden_patterns = [
        r'\binsert\b', r'\bupdate\b', r'\bdelete\b', r'\bdrop\b', 
        r'\bcreate\b', r'\balter\b', r'\btruncate\b', r'\bexec\b',
        r'\bexecute\b', r'\bcall\b', r'\blimit\b'
    ]
    
    for pattern in forbidden_patterns:
        if re.search(pattern, query_clean):
            return False
    
    return True

@mcp.tool()
async def execute_select(query: str, limit: int = 10) -> Dict[str, Any]:
    """Execute a SELECT query with automatic row limiting for safe data exploration.
    
    Args:
        query: SELECT statement (no LIMIT clause allowed - will be added automatically)
        limit: Maximum rows to return (1-25, defaults to 10)
    
    Safety features:
    - Only SELECT statements allowed (no INSERT, UPDATE, DELETE, etc.)
    - Automatic LIMIT clause prevents large result sets
    - Query validation blocks modification operations
    
    Example usage:
    - execute_select('SELECT * FROM users', 5) - get first 5 users
    - execute_select('SELECT name, email FROM customers WHERE active = true', 15)
    - execute_select('SELECT COUNT(*) FROM orders') - get count (limit=1 is fine)
    - execute_select('SELECT * FROM products ORDER BY created_at DESC', 25) - newest 25 products
    
    Note: Do not include LIMIT in your query - it will be added automatically based on the limit parameter.
    """
    if not validate_select_query(query):
        return {
            "error": "Query must be a SELECT statement with no LIMIT clause and no modification operations"
        }
    
    # Validate limit parameter
    if not isinstance(limit, int) or limit < 1 or limit > 25:
        return {
            "error": "Limit must be an integer between 1 and 25"
        }
    
    if not db.pool:
        await db.initialize()
    
    try:
        async with db.pool.acquire() as conn:
            # Append LIMIT clause programmatically
            query_with_limit = f"{query.rstrip(';')} LIMIT {limit}"
            rows = await conn.fetch(query_with_limit)
            
            return {
                "query": query_with_limit,
                "row_count": len(rows),
                "data": [dict(row) for row in rows]
            }
    except Exception as e:
        return {
            "error": f"Query execution failed: {str(e)}"
        }

@mcp.tool()
async def count_rows(table_name: str, schema_name: str = "public", where_clause: str = "") -> Dict[str, Any]:
    """Count rows in a table with optional filtering via WHERE clause.
    
    Args:
        table_name: Name of the table to count
        schema_name: Schema containing the table (defaults to 'public')
        where_clause: Optional WHERE conditions (without the 'WHERE' keyword)
    
    Safety features:
    - WHERE clause validation prevents modification operations
    - Proper table/schema name quoting to handle special characters
    
    Example usage:
    - count_rows('users') - total count of all users
    - count_rows('orders', 'sales') - count orders in sales schema
    - count_rows('products', where_clause='active = true') - count active products
    - count_rows('transactions', where_clause='amount > 100 AND created_at > \'2024-01-01\'') - conditional count
    
    Note: Do not include 'WHERE' in the where_clause parameter - it will be added automatically.
    """
    if not db.pool:
        await db.initialize()
    
    try:
        base_query = f'SELECT COUNT(*) FROM "{schema_name}"."{table_name}"'
        
        if where_clause.strip():
            where_clean = where_clause.strip().lower()
            forbidden_keywords = ['insert', 'update', 'delete', 'drop', 'create', 'alter', 'truncate']
            if any(keyword in where_clean for keyword in forbidden_keywords):
                return {"error": "WHERE clause contains forbidden operations"}
            
            base_query += f" WHERE {where_clause}"
        
        async with db.pool.acquire() as conn:
            result = await conn.fetchval(base_query)
            
            return {
                "table": f"{schema_name}.{table_name}",
                "where_clause": where_clause if where_clause else "none",
                "count": result
            }
    except Exception as e:
        return {
            "error": f"Count query failed: {str(e)}"
        }

if __name__ == "__main__":
    mcp.run(transport="stdio")