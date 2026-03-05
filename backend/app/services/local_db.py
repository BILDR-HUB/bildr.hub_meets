"""
local_db.py – Direct PostgreSQL client for local development.

Replaces the Supabase client when running without Supabase Cloud.
Provides the same interface pattern (table().select/insert/update/eq).
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any

import psycopg2
import psycopg2.extras

logger = logging.getLogger(__name__)

def _get_conn_str() -> str:
    from app.core.config import settings
    url = settings.database_url
    return url.replace("postgresql+asyncpg://", "postgresql://")


def _get_conn():
    return psycopg2.connect(_get_conn_str())


class _Result:
    """Mimics Supabase response object."""
    def __init__(self, data: list[dict]):
        self.data = data


class _QueryBuilder:
    """Mimics Supabase query builder chain."""

    def __init__(self, table_name: str):
        self._table = table_name
        self._operation: str = "select"
        self._select_cols = "*"
        self._data: dict = {}
        self._filters: list[tuple[str, str, Any]] = []
        self._order_col: str | None = None
        self._order_desc: bool = False
        self._limit: int | None = None
        self._offset: int | None = None
        self._single: bool = False

    def select(self, cols: str = "*") -> "_QueryBuilder":
        self._operation = "select"
        self._select_cols = cols
        return self

    def insert(self, data: dict) -> "_QueryBuilder":
        self._operation = "insert"
        self._data = data
        return self

    def update(self, data: dict) -> "_QueryBuilder":
        self._operation = "update"
        self._data = data
        return self

    def delete(self) -> "_QueryBuilder":
        self._operation = "delete"
        return self

    def eq(self, col: str, val: Any) -> "_QueryBuilder":
        self._filters.append((col, "=", val))
        return self

    def order(self, col: str, desc: bool = False) -> "_QueryBuilder":
        self._order_col = col
        self._order_desc = desc
        return self

    def range(self, start: int, end: int) -> "_QueryBuilder":
        self._offset = start
        self._limit = end - start + 1
        return self

    def limit(self, count: int) -> "_QueryBuilder":
        self._limit = count
        return self

    def single(self) -> "_QueryBuilder":
        self._single = True
        self._limit = 1
        return self

    def execute(self) -> _Result:
        conn = _get_conn()
        try:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                if self._operation == "select":
                    return self._exec_select(cur)
                elif self._operation == "insert":
                    return self._exec_insert(cur, conn)
                elif self._operation == "update":
                    return self._exec_update(cur, conn)
                elif self._operation == "delete":
                    return self._exec_delete(cur, conn)
                else:
                    return _Result([])
        finally:
            conn.close()

    def _exec_select(self, cur) -> _Result:
        sql = f"SELECT {self._select_cols} FROM {self._table}"
        params: list = []

        if self._filters:
            clauses = []
            for col, op, val in self._filters:
                clauses.append(f"{col} {op} %s")
                params.append(val)
            sql += " WHERE " + " AND ".join(clauses)

        if self._order_col:
            sql += f" ORDER BY {self._order_col}"
            if self._order_desc:
                sql += " DESC"

        if self._limit:
            sql += " LIMIT %s"
            params.append(self._limit)
        if self._offset:
            sql += " OFFSET %s"
            params.append(self._offset)

        cur.execute(sql, params)
        rows = cur.fetchall()
        data = [_serialize_row(dict(r)) for r in rows]

        if self._single:
            return _Result(data[0] if data else None)
        return _Result(data)

    def _exec_insert(self, cur, conn) -> _Result:
        cols = list(self._data.keys())
        vals = []
        for c in cols:
            v = self._data[c]
            if isinstance(v, (dict, list)):
                vals.append(json.dumps(v))
            else:
                vals.append(v)
        placeholders = ", ".join(["%s"] * len(cols))
        col_names = ", ".join(cols)

        sql = f"INSERT INTO {self._table} ({col_names}) VALUES ({placeholders}) RETURNING *"
        cur.execute(sql, vals)
        conn.commit()
        row = cur.fetchone()
        return _Result([_serialize_row(dict(row))] if row else [])

    def _exec_update(self, cur, conn) -> _Result:
        sets = []
        params: list = []
        for col, val in self._data.items():
            sets.append(f"{col} = %s")
            if isinstance(val, (dict, list)):
                params.append(json.dumps(val))
            else:
                params.append(val)

        sql = f"UPDATE {self._table} SET {', '.join(sets)}"

        if self._filters:
            clauses = []
            for col, op, val in self._filters:
                clauses.append(f"{col} {op} %s")
                params.append(val)
            sql += " WHERE " + " AND ".join(clauses)

        sql += " RETURNING *"
        cur.execute(sql, params)
        conn.commit()
        rows = cur.fetchall()
        return _Result([_serialize_row(dict(r)) for r in rows])


    def _exec_delete(self, cur, conn) -> _Result:
        sql = f"DELETE FROM {self._table}"
        params: list = []

        if self._filters:
            clauses = []
            for col, op, val in self._filters:
                clauses.append(f"{col} {op} %s")
                params.append(val)
            sql += " WHERE " + " AND ".join(clauses)

        sql += " RETURNING *"
        cur.execute(sql, params)
        conn.commit()
        rows = cur.fetchall()
        return _Result([_serialize_row(dict(r)) for r in rows])


def _serialize_row(row: dict) -> dict:
    """Convert non-JSON-serializable types to strings."""
    from datetime import datetime
    from uuid import UUID
    result = {}
    for k, v in row.items():
        if isinstance(v, UUID):
            result[k] = str(v)
        elif isinstance(v, datetime):
            result[k] = v.isoformat()
        else:
            result[k] = v
    return result


class _StorageBucket:
    """Mock storage that saves files to local disk."""

    def __init__(self, bucket_name: str):
        self._bucket = bucket_name
        self._base_dir = os.path.join(
            os.path.dirname(os.path.dirname(os.path.dirname(__file__))),
            "local_storage",
            bucket_name,
        )
        os.makedirs(self._base_dir, exist_ok=True)

    def upload(self, path: str, file: bytes, file_options: dict | None = None):
        full_path = os.path.join(self._base_dir, path)
        os.makedirs(os.path.dirname(full_path), exist_ok=True)
        with open(full_path, "wb") as f:
            f.write(file)
        logger.info("Saved file locally: %s", full_path)

    def get_public_url(self, path: str) -> str:
        return f"file://{os.path.join(self._base_dir, path)}"


class _Storage:
    def from_(self, bucket_name: str) -> _StorageBucket:
        return _StorageBucket(bucket_name)


class LocalDB:
    """Drop-in replacement for Supabase client in local dev."""

    def __init__(self):
        self.storage = _Storage()

    def table(self, name: str) -> _QueryBuilder:
        return _QueryBuilder(name)


# Singleton
local_db = LocalDB()
