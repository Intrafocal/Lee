"""
The Desk's HTTP routes on the Hester daemon (:9000), Desk D2 contract §4.

The copilot envelope as everywhere: ``{success: true, data, workspace,
workspace_id}``, errors ``{success: false, error}``: 400 with a message, 404
``not found``, 409 with a code (``not_empty``, ``version_conflict``,
``not_put_away``, ``not_open``). The workspace comes from ``?workspace=`` or
``X-Lee-Workspace``, else the body's ``workspace``, else the active one.
Every route runs the migration first when it's due (``DeskStore.load``).

A Page card has the routes a Page had under ``/cockpit/explorations/{id}``,
with the same functions (deep.py) on the card's store, so the Page's rules
hold exactly. Nothing here deletes a card with content or an Area with cards.
"""

import asyncio
from typing import Optional

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from . import deep, deep_ask, handoffs
from .desk import DEFAULT_SESSIONS, MAX_SESSIONS, DeskConflict
from .explorations import ExplorationError, ExplorationNotFound
from .tasks import TaskError, TaskNotFound


def create_desk_router() -> APIRouter:
    from .routes import BadRequest, _body, _err, _int, _log_deep_request, _ok, context_for

    router = APIRouter(tags=["desk"])

    async def _op(request: Request, fn, status: int = 200, recover: bool = False):
        """Run ``fn(ctx, desk, body)`` (sync; may return ``(data, status)``) under the workspace lock."""
        try:
            body = await _body(request)
            ctx = context_for(body.pop("workspace", None))
            if recover:
                await deep_ask.get_runner().ensure_recovered(ctx, "desk")
            async with ctx.lock:
                desk = ctx.desk()
                desk.load()
                data = fn(ctx, desk, body)
        except BadRequest as e:
            return _err(str(e), e.status)
        except DeskConflict as e:
            return _err(e.code, 409)
        except deep.PageConflict as e:
            conflict = {"error": "version_conflict", "version": e.version, "text": e.text}
            return JSONResponse(status_code=409, content={"success": False, **conflict, "data": conflict})
        except (ExplorationError, TaskError) as e:
            return _err(str(e))
        except (ExplorationNotFound, TaskNotFound):
            return _err("not found", 404)
        if isinstance(data, tuple):
            data, status = data
        return _ok(ctx, data, status)

    # ------------------------------------------------------------ the Desk

    @router.get("/desk")
    async def desk_get(request: Request):
        return await _op(request, lambda ctx, desk, b: desk.desk(), recover=True)

    @router.post("/desk/migrate")
    async def desk_migrate(request: Request):
        return await _op(request, lambda ctx, desk, b: desk.migrate())

    @router.get("/desk/last")
    async def desk_last(request: Request):
        def op(ctx, desk, b):
            from ..copilot import open_next

            return desk.last(open_next_rec=open_next.get(ctx.path))
        return await _op(request, op, recover=True)

    @router.put("/desk/last")
    async def desk_last_put(request: Request):
        return await _op(request, lambda ctx, desk, b: desk.set_last(b.get("card_id")))

    # ------------------------------------------------------------ Areas and Drawers

    @router.post("/desk/areas")
    async def desk_area_create(request: Request):
        return await _op(request, lambda ctx, desk, b: desk.create_area(b), 201)

    @router.patch("/desk/areas/{area_id}")
    async def desk_area_patch(area_id: str, request: Request):
        return await _op(request, lambda ctx, desk, b: desk.patch_area(area_id, b))

    @router.delete("/desk/areas/{area_id}")
    async def desk_area_delete(area_id: str, request: Request):
        """An empty Area; ``{"with_cards": true}`` deletes its cards too (the user confirmed)."""
        return await _op(request, lambda ctx, desk, b: desk.delete_area(area_id, with_cards=b.get("with_cards") is True))

    @router.post("/desk/areas/{area_id}/put-away")
    async def desk_area_put_away(area_id: str, request: Request):
        return await _op(request, lambda ctx, desk, b: desk.put_away(area_id, b))

    @router.post("/desk/areas/{area_id}/take-out")
    async def desk_area_take_out(area_id: str, request: Request):
        return await _op(request, lambda ctx, desk, b: desk.take_out(area_id, b))

    @router.post("/desk/drawers")
    async def desk_drawer_create(request: Request):
        return await _op(request, lambda ctx, desk, b: desk.create_drawer(b), 201)

    @router.patch("/desk/drawers/{drawer_id}")
    async def desk_drawer_patch(drawer_id: str, request: Request):
        return await _op(request, lambda ctx, desk, b: desk.patch_drawer(drawer_id, b))

    # ------------------------------------------------------------ cards

    @router.patch("/desk/cards/{card_id}")
    async def desk_card_patch(card_id: str, request: Request):
        return await _op(request, lambda ctx, desk, b: desk.patch_card(card_id, b))

    # ------------------------------------------------------------ strokes (lines that mean nothing)

    @router.post("/desk/strokes")
    async def desk_stroke_create(request: Request):
        return await _op(request, lambda ctx, desk, b: desk.create_stroke(b), 201)

    @router.delete("/desk/strokes/{stroke_id}")
    async def desk_stroke_delete(stroke_id: str, request: Request):
        return await _op(request, lambda ctx, desk, b: desk.delete_stroke(stroke_id))

    @router.post("/desk/pages")
    async def desk_page_create(request: Request):
        """201 with the new card and its Page; 200 with ``created: false`` for the existing Goals card."""
        def op(ctx, desk, b):
            b.pop("origin", None)  # set by the store (``from``, an idea), never by the caller
            card, page, created = desk.create_page(b)
            return {"card": card, "page": page, "created": created}, 201 if created else 200
        return await _op(request, op)

    @router.post("/desk/ideas/{someday_id}/page")
    async def desk_idea_to_page(someday_id: str, request: Request):
        def op(ctx, desk, b):
            from ..copilot import lee_events
            from ..copilot.routes import caller_actor
            from ..copilot.someday import age_ms

            made = desk.idea_to_page(someday_id, b)
            try:
                item = ctx.someday().get(someday_id)
                lee_events.ingest("someday.triage", {"someday_id": someday_id, "action": "explore", "age_ms": age_ms(item)},
                                  workspace=str(ctx.path), actor=caller_actor(request))
            except Exception:
                pass
            return made, 201
        return await _op(request, op)

    @router.get("/desk/pages/{card_id}")
    async def desk_page_get(card_id: str, request: Request):
        return await _op(request, lambda ctx, desk, b: desk.get_card(card_id), recover=True)

    @router.patch("/desk/pages/{card_id}")
    async def desk_page_patch(card_id: str, request: Request):
        return await _op(request, lambda ctx, desk, b: desk.patch_page(card_id, b))

    @router.delete("/desk/pages/{card_id}")
    async def desk_page_delete(card_id: str, request: Request):
        """Deep next R8's guard on a card: only an empty, still-Untitled one goes; else 409 not_empty.
        ``{"force": true}`` deletes it anyway (the user confirmed)."""
        return await _op(request, lambda ctx, desk, b: desk.delete_page(card_id, force=b.get("force") is True))

    # ------------------------------------------------------------ a Page card's records (deep.py)

    def _card(desk, card_id: str):
        desk.pages.require(card_id)  # 400 for a bad id, 404 for an unknown one
        return desk.pages

    @router.get("/desk/pages/{card_id}/page")
    async def desk_page_text(card_id: str, request: Request):
        return await _op(request, lambda ctx, desk, b: deep.read_page(_card(desk, card_id), card_id))

    @router.put("/desk/pages/{card_id}/page")
    async def desk_page_text_put(card_id: str, request: Request):
        """The user's Page; 409 ``version_conflict`` with the current text when ``base_version`` is stale."""
        return await _op(request, lambda ctx, desk, b: deep.write_page(_card(desk, card_id), card_id, b))

    @router.get("/desk/pages/{card_id}/references")
    async def desk_references(card_id: str, request: Request):
        return await _op(request, lambda ctx, desk, b: deep.list_references(_card(desk, card_id), card_id))

    @router.post("/desk/pages/{card_id}/references")
    async def desk_reference_add(card_id: str, request: Request):
        return await _op(request, lambda ctx, desk, b: deep.add_reference(_card(desk, card_id), card_id, b), 201)

    @router.patch("/desk/pages/{card_id}/references/{ref_id}")
    async def desk_reference_patch(card_id: str, ref_id: str, request: Request):
        return await _op(request, lambda ctx, desk, b: deep.patch_reference(_card(desk, card_id), card_id, ref_id, b))

    @router.get("/desk/pages/{card_id}/answers")
    async def desk_answers(card_id: str, request: Request):
        return await _op(request, lambda ctx, desk, b: deep.list_answers(_card(desk, card_id), card_id), recover=True)

    @router.post("/desk/pages/{card_id}/asks")
    async def desk_ask(card_id: str, request: Request):
        """deep-ask on a card: recorded queued and run in the background; 202."""
        trigger = deep_ask.request_trigger()

        def op(ctx, desk, b):
            answer = deep.new_answer(_card(desk, card_id), card_id, b)
            _log_deep_request(ctx, request)
            deep_ask.get_runner().schedule(deep_ask.Job(ctx, card_id, answer["id"], trigger))
            return answer
        return await _op(request, op, 202, recover=True)

    @router.patch("/desk/pages/{card_id}/answers/{answer_id}")
    async def desk_answer_patch(card_id: str, answer_id: str, request: Request):
        def op(ctx, desk, b):
            row = deep.patch_answer(_card(desk, card_id), card_id, answer_id, b)
            if "task_id" in b or "status" in b:
                # The task may already be ahead of the record (the relay beats this PATCH).
                task_id = (row.get("handoff") or {}).get("task_id")
                task = ctx.tasks().get(task_id) if task_id else None
                if task is not None:
                    row = handoffs.sync(ctx, task) or row
            return row
        return await _op(request, op)

    @router.post("/desk/pages/{card_id}/answers/{answer_id}/retry")
    async def desk_answer_retry(card_id: str, answer_id: str, request: Request):
        trigger = deep_ask.request_trigger()

        def op(ctx, desk, b):
            answer = deep.requeue_answer(_card(desk, card_id), card_id, answer_id)
            _log_deep_request(ctx, request)
            deep_ask.get_runner().schedule(deep_ask.Job(ctx, card_id, answer_id, trigger))
            return answer
        return await _op(request, op, 202, recover=True)

    @router.post("/desk/pages/{card_id}/handoffs")
    async def desk_handoff(card_id: str, request: Request):
        """A hand-off record in state 'launching'; the renderer launches the task with origin {kind: 'page', ref}."""
        return await _op(request, lambda ctx, desk, b: deep.new_handoff(_card(desk, card_id), card_id, b), 201)

    @router.get("/desk/pages/{card_id}/questions")
    async def desk_questions(card_id: str, request: Request):
        return await _op(request, lambda ctx, desk, b: deep.list_questions(_card(desk, card_id), card_id))

    @router.post("/desk/pages/{card_id}/questions")
    async def desk_question_add(card_id: str, request: Request):
        return await _op(request, lambda ctx, desk, b: deep.add_question(_card(desk, card_id), card_id, b), 201)

    @router.patch("/desk/pages/{card_id}/questions/{question_id}")
    async def desk_question_patch(card_id: str, question_id: str, request: Request):
        return await _op(request, lambda ctx, desk, b: deep.patch_question(_card(desk, card_id), card_id, question_id, b))

    @router.post("/desk/pages/{card_id}/draft-from-readme")
    async def desk_draft_from_readme(card_id: str, request: Request):
        """The Goals card's Draft from README (a user action): ``{text, sources}``; never writes the Page."""
        from .steward import StewardError

        try:
            body = await _body(request)
            ctx = context_for(body.pop("workspace", None))
            async with ctx.lock:
                await asyncio.to_thread(ctx.desk().load)
            data = await deep_ask.draft_from_readme(ctx, card_id)
        except BadRequest as e:
            return _err(str(e), e.status)
        except StewardError as e:
            return _err(str(e), e.status)
        except ExplorationError as e:
            return _err(str(e))
        except ExplorationNotFound:
            return _err("not found", 404)
        return _ok(ctx, data)

    # ------------------------------------------------------------ sessions

    @router.get("/desk/sessions")
    async def desk_sessions(request: Request, limit: Optional[str] = None):
        def op(ctx, desk, b):
            n = _int(limit, DEFAULT_SESSIONS, 1, MAX_SESSIONS, "limit")
            return desk.list_sessions(n)
        return await _op(request, op)

    @router.post("/desk/sessions")
    async def desk_session_add(request: Request):
        def op(ctx, desk, b):
            from ..copilot import open_next

            record = desk.add_session(b)
            open_next.on_desk_session(ctx.path, record)  # the next session happened (14 §8.1)
            return record
        return await _op(request, op, 201)

    return router
