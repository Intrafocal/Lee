from hester.daemon.cockpit.plain import looks_like_code, plain_title, strip_markdown


def test_plain_title_strips_markdown_and_code():
    text = "## **Fixed** the `fs/list` 404\n\n```ts\nconst x = 1;\n```\nMore words."
    assert plain_title(text) == "Fixed the fs/list 404"


def test_plain_title_skips_code_lines_and_takes_first_sentence():
    text = "const handler = (req) => {\n  return 1;\n}\nThe parser now handles quoted keys. It also logs."
    assert plain_title(text) == "The parser now handles quoted keys."


def test_plain_title_clips_at_a_word():
    t = plain_title("word " * 40, 80)
    assert len(t) <= 80 and t.endswith("…") and not t.endswith(" …")


def test_plain_title_empty_for_code_only_or_lee_status():
    assert plain_title("```lee-status\nstatus: done\n```") == ""
    assert plain_title("x = foo(bar);") == ""
    assert plain_title(None) == ""


def test_strip_markdown_links_lists_tables():
    assert strip_markdown("- [x] see [docs](http://a)\n| a | b |\n|---|---|") == ["see docs", "a · b"]
    assert looks_like_code("if (a) {") and not looks_like_code("Call render() twice.")
