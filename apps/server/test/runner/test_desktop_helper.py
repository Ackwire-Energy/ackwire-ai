"""
Unit tests for the pure parts of the desktop helper (no X, no D-Bus): python3 -I this_file.py.
desktop-helper.test.ts runs them in the test suite.
"""

import importlib.util
import json
import os
import sys
import unittest

# Loading the helper from its file would leave a __pycache__ next to it, in the runner's sources.
sys.dont_write_bytecode = True
HELPER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "runner", "desktop-helper.py")
spec = importlib.util.spec_from_file_location("desktop_helper", HELPER)
h = importlib.util.module_from_spec(spec)
spec.loader.exec_module(h)

APP = ":1.5"
ROOT = "/org/a11y/atspi/accessible/root"
SHOWING = h.SHOWING


def ref(path, bus=APP):
    return (bus, path)


def new_item(path, parent, index, count, name, role, ifaces=("Accessible", "Component"), states=(SHOWING, 0), pbus=APP):
    """An item as at-spi2-core 2.56 sends it: ((so)(so)(so)iiassusau)."""
    ifaces = ["org.a11y.atspi." + i for i in ifaces]
    return (ref(path), ref(ROOT), ref(parent, pbus), index, count, ifaces, name, role, "", list(states))


def old_item(path, parent, children, name, role, ifaces=("Accessible", "Component"), states=(SHOWING, 0), pbus=APP):
    """The same item as older at-spi2 sends it: ((so)(so)(so)a(so)assusau)."""
    ifaces = ["org.a11y.atspi." + i for i in ifaces]
    return (ref(path), ref(ROOT), ref(parent, pbus), [ref(c) for c in children], ifaces, name, role, "", list(states))


class GetItemsFormats(unittest.TestCase):
    def test_both_signatures_give_the_same_nodes(self):
        a, b, c = "/org/a11y/atspi/accessible/1", "/org/a11y/atspi/accessible/2", "/org/a11y/atspi/accessible/3"
        new = [
            new_item(ROOT, ROOT, -1, 1, "thunar", 75, ("Accessible", "Application"), (0, 0), pbus="org.a11y.atspi.Registry"),
            new_item(a, ROOT, 0, 2, "Files", 23),
            new_item(b, a, 0, 0, "Back", 43, ("Accessible", "Component", "Action")),
            new_item(c, a, 1, 0, "Location", 79, ("Accessible", "Component", "Text", "EditableText")),
        ]
        old = [
            old_item(ROOT, ROOT, [a], "thunar", 75, ("Accessible", "Application"), (0, 0), pbus="org.a11y.atspi.Registry"),
            old_item(a, ROOT, [b, c], "Files", 23),
            old_item(b, a, [], "Back", 43, ("Accessible", "Component", "Action")),
            old_item(c, a, [], "Location", 79, ("Accessible", "Component", "Text", "EditableText")),
        ]
        nodes = h.normalize_items(new)
        old_nodes = h.normalize_items(old)
        self.assertEqual(nodes[1:], old_nodes[1:])
        # The root's index is unknown in both; its parent is the desktop, on the registry's bus.
        self.assertEqual(nodes[0]["parent"], None)
        self.assertEqual(old_nodes[0]["parent"], None)
        self.assertEqual(old_nodes[0]["children"], 1)
        self.assertEqual(
            nodes[3],
            {
                "path": c,
                "parent": a,
                "index": 1,
                "children": 0,
                "role": 79,
                "name": "Location",
                "states": [SHOWING, 0],
                "ifaces": ["Accessible", "Component", "Text", "EditableText"],
            },
        )

    def test_a_null_parent_and_long_names(self):
        item = new_item("/x/1", h.NULL_PATH, 0, 0, "n" * 1000, 43)
        node = h.normalize_items([item])[0]
        self.assertIsNone(node["parent"])
        self.assertEqual(len(node["name"]), h.NAME_MAX)

    def test_an_old_item_missing_from_its_parents_children(self):
        node = h.normalize_items([old_item("/x/9", "/x/1", [], "orphan", 43)])[0]
        self.assertEqual(node["index"], -1)


class BusyTiles(unittest.TestCase):
    def test_tiles_a_rectangle_touches(self):
        self.assertEqual(h.tiles(0, 0, 32, 32), {(0, 0)})
        self.assertEqual(h.tiles(31, 0, 2, 1), {(0, 0), (1, 0)})
        self.assertEqual(h.tiles(64, 64, 0, 10), set())
        self.assertEqual(len(h.tiles(0, 0, 1280, 800)), 40 * 25)

    def test_what_changed_just_before_is_busy(self):
        d = h.Damage()
        d.add((0, 0, 10, 10), now=1.0)  # a clock, long ago
        d.add((100, 100, 10, 10), now=9.9)  # a spinner, just now
        self.assertEqual(d.busy(10.0), {(3, 3)})
        self.assertEqual(d.busy(10.0, window=10), {(0, 0), (3, 3)})

    def test_busy_tiles_are_masked_from_the_change(self):
        d = h.Damage()
        busy = {(3, 3)}
        self.assertFalse(d.add((100, 100, 10, 10), now=1) - busy)
        self.assertEqual(d.add((90, 90, 20, 20), now=1) - busy, {(2, 2), (2, 3), (3, 2)})


def run(settle, events, step_ms=1, limit_ms=30000):
    """Feeds `events` ([(time s, "damage" | "window")]) to a Settle started at 0, a clock tick per ms."""
    events = sorted(events)
    for ms in range(limit_ms):
        now = ms / 1000
        while events and events[0][0] <= now:
            t, kind = events.pop(0)
            getattr(settle, kind)(t)
        result = settle.done(now)
        if result is not None:
            return ms, result, settle.changed
    raise AssertionError("never ended")


class SettleStates(unittest.TestCase):
    def assertEnds(self, got, ms, settled, changed):
        """Ended at `ms` (give or take a tick of float rounding), settled or capped, with or without a change."""
        self.assertEqual(got[1:], (settled, changed))
        self.assertLessEqual(abs(got[0] - ms), 2, got)

    def test_nothing_changes(self):
        self.assertEnds(run(h.Settle(0), []), 400, True, False)

    def test_quiet_after_the_first_change(self):
        self.assertEnds(run(h.Settle(0), [(0.05, "damage")]), 170, True, True)

    def test_a_late_first_change(self):
        self.assertEnds(run(h.Settle(0), [(0.3, "damage")]), 420, True, True)

    def test_a_change_after_the_late_wait_is_not_waited_for(self):
        self.assertEnds(run(h.Settle(0), [(0.5, "damage")]), 400, True, False)

    def test_it_never_quiets_and_the_cap_ends_it(self):
        events = [(i * 0.05, "damage") for i in range(1, 100)]
        self.assertEnds(run(h.Settle(0), events), 2000, False, True)

    def test_own_numbers(self):
        self.assertEnds(run(h.Settle(0, late=100, quiet=50, cap=300), []), 100, True, False)
        events = [(i * 0.03, "damage") for i in range(1, 100)]
        self.assertEnds(run(h.Settle(0, late=100, quiet=50, cap=300), events), 300, False, True)

    def test_an_app_starting_waits_for_its_window(self):
        # The menu closing at 0.1 s doesn't end it; the window at 1.5 s does, once it is quiet.
        events = [(0.1, "damage"), (1.5, "window"), (1.55, "damage")]
        self.assertEnds(run(h.Settle(0, window=10000), events), 1670, True, True)

    def test_no_window_comes(self):
        self.assertEnds(run(h.Settle(0, window=2000), []), 2000, True, False)
        self.assertEnds(run(h.Settle(0, window=2000), [(1.95, "damage")]), 2070, True, True)
        self.assertEnds(run(h.Settle(0, window=2000), [(0.5, "damage")]), 2000, True, True)

    def test_the_wait_starts_when_the_action_is_done(self):
        # Typing changed the screen while it ran (until 1.2 s): quiet 120 ms after its last change.
        s = h.Settle(0)
        s.damage(0.3)
        s.damage(1.2)
        s.start(1.25)
        self.assertEnds(run(s, []), 1320, True, True)

    def test_wake_says_when_to_look_again(self):
        s = h.Settle(0)
        self.assertAlmostEqual(s.wake(0.1), 0.3)
        s.damage(0.2)
        self.assertAlmostEqual(s.wake(0.25), 0.07)
        w = h.Settle(0, window=1000)
        self.assertAlmostEqual(w.wake(0.4), 0.6)


class Typing(unittest.TestCase):
    def test_keys_and_pastes(self):
        self.assertEqual(h.text_runs("echo João\n"), [(True, "echo Jo"), (False, "ã"), (True, "o\n")])
        self.assertEqual(h.text_runs("ls -la\t~"), [(True, "ls -la\t~")])
        self.assertEqual(h.text_runs("日本"), [(False, "日本")])
        self.assertEqual(h.text_runs(""), [])

    def test_runs_put_back_together_are_the_text(self):
        for text in h.CHECK_STRINGS:
            self.assertEqual("".join(run for _, run in h.text_runs(text)), text)


class Steps(unittest.TestCase):
    screen = [1280, 800]

    def kind(self, step):
        return h.check_step(step, self.screen)

    def refused(self, step):
        with self.assertRaises(h.HelperError) as e:
            self.kind(step)
        self.assertEqual(e.exception.code, "bad_request")

    def test_valid_steps(self):
        self.assertEqual(self.kind({"click": [10, 20], "button": 3, "count": 2}), "click")
        self.assertEqual(self.kind({"drag": [0, 0, 1279, 799]}), "drag")
        self.assertEqual(self.kind({"key": "ctrl+shift+Tab"}), "key")
        self.assertEqual(self.kind({"type": "Olá"}), "type")
        self.assertEqual(self.kind({"fill": [APP, "/org/a11y/atspi/accessible/3"], "text": ""}), "fill")
        self.assertEqual(self.kind({"scroll": [5, 5], "dy": -3}), "scroll")
        self.assertEqual(self.kind({"launch": "org.xfce.mousepad.desktop"}), "launch")
        self.assertEqual(self.kind({"open": "/home/agent/notes.md"}), "open")
        self.assertEqual(self.kind({"pause": 0}), "pause")
        self.assertEqual(self.kind({"activate": 23068675}), "activate")

    def test_refused_steps(self):
        self.refused({"click": [1280, 10]})
        self.refused({"click": [10, 10], "button": 4})
        self.refused({"click": [True, 10]})
        self.refused({"move": [1, 2], "click": [1, 2]})
        self.refused({"key": "--window"})
        self.refused({"key": "ctrl+"})
        self.refused({"type": ""})
        self.refused({"type": "x" * (h.TEXT_MAX + 1)})
        self.refused({"fill": ["only-a-bus"], "text": "x"})
        self.refused({"scroll": [5, 5]})
        self.refused({"launch": "../../bin/sh"})
        self.refused({"open": "notes.md"})
        self.refused({"pause": 60000})
        self.refused({"teleport": [1, 1]})

    def test_settle_specs(self):
        self.assertIsNone(h.check_settle(None))
        self.assertEqual(h.check_settle({"lateMs": 100, "windowMs": 9000}), {"late": 100, "window": 9000})
        with self.assertRaises(h.HelperError):
            h.check_settle({"lateMs": -1})
        with self.assertRaises(h.HelperError):
            h.check_settle({"soonMs": 1})


class Screen(unittest.TestCase):
    def test_regions_stay_on_the_screen(self):
        screen = [1280, 800]
        region = {"x": 1100, "y": -20, "width": 480, "height": 300}
        self.assertEqual(h.clamp_region(region, screen), {"x": 1100, "y": 0, "width": 180, "height": 280})
        with self.assertRaises(h.HelperError):
            h.clamp_region({"x": 2000, "y": 0, "width": 10, "height": 10}, screen)

    def test_what_is_in_front(self):
        def win(pid, active=False, types=("normal",)):
            return {"pid": pid, "active": active, "types": list(types)}

        windows = [win(1, types=("desktop",)), win(2), win(3, active=True), win(4, types=("popup_menu",)), win(5, types=("dock",))]
        self.assertEqual(h.front_pids(windows), {3, 4, 5})
        windows.insert(0, windows.pop())  # a panel at the bottom of the stack still counts
        self.assertEqual(h.front_pids(windows), {3, 4, 5})
        self.assertEqual(h.front_pids([win(1), win(None), win(2)]), {1, 2})

    def test_off_screen_windows(self):
        self.assertTrue(h.on_screen([0, 0, 1280, 27], [1280, 800]))
        self.assertFalse(h.on_screen([-1000, -1000, 5, 5], [1280, 800]))
        self.assertFalse(h.on_screen([0, 800, 1280, 1], [1280, 800]))

    def test_text_caps(self):
        self.assertEqual(h.cap_text("abcdef", "terminal", 3), "def")
        self.assertEqual(h.cap_text("abcdef", "entry", 3), "abc")
        self.assertEqual(h.cap_text("abc", "entry", 3), "abc")


def node(path, parent, box=None, states=(SHOWING, 0)):
    n = {"path": path, "parent": parent, "index": 0, "children": 0, "role": 43, "name": "", "states": list(states), "ifaces": []}
    if box is not None:
        n["box"] = list(box)
    return n


class Gtk4Boxes(unittest.TestCase):
    """GTK4 says (0, 0) for every screen position; its boxes are then asked from the window."""

    window = {"xid": 7, "pid": 40, "box": [200, 100, 640, 480]}

    def test_every_box_at_the_corner_of_a_window_elsewhere(self):
        nodes = [
            node(ROOT, None),
            node("/f", ROOT, (0, 0, 600, 440)),
            node("/b", "/f", (0, 0, 80, 30)),
            node("/hidden", "/f", states=(0, 0)),
            node("/t", "/b", (0, 0, 60, 20)),
        ]
        other = {"xid": 8, "pid": 40, "box": [0, 0, 300, 200]}
        [(win, members)] = h.misplaced(nodes, 40, [other, self.window])
        self.assertEqual(win["xid"], 7)
        self.assertEqual(sorted(m["path"] for m in members), ["/b", "/f", "/t"])

    def test_gtk3_and_lone_windows_stay_as_they_are(self):
        gtk3 = [node(ROOT, None), node("/f", ROOT, (0, 0, 1280, 800)), node("/b", "/f", (12, 40, 80, 30))]
        self.assertEqual(h.misplaced(gtk3, 40, [dict(self.window, box=[0, 0, 1280, 800])]), [])
        lone = [node(ROOT, None), node("/f", ROOT, (0, 0, 1280, 800))]
        self.assertEqual(h.misplaced(lone, 40, [dict(self.window, box=[0, 0, 1280, 800])]), [])
        # A lone frame at the corner, on a window that isn't: still GTK4's.
        self.assertEqual(len(h.misplaced(lone, 40, [self.window])), 1)
        self.assertEqual(h.misplaced(gtk3, None, [self.window]), [])
        self.assertEqual(h.misplaced(gtk3, 41, [self.window]), [])


class Walk(unittest.TestCase):
    """Qt keeps no cache: its tree is read node by node, below showing nodes only, capped."""

    TREE = {
        ROOT: (75, [0, 0], "app", ["Accessible", "Application"], ["/w", "/hidden"]),
        "/w": (23, [SHOWING, 0], "Main", ["Accessible", "Component"], ["/b", "/p", ROOT]),
        "/hidden": (23, [0, 0], "Settings", ["Accessible", "Component"], ["/x"]),
        "/b": (43, [SHOWING, 0], "OK", ["Accessible", "Component", "Action"], []),
        "/p": (39, [0, 0], "", ["Accessible"], ["/deep"]),
        "/x": (43, [SHOWING, 0], "never asked", [], []),
        "/deep": (43, [SHOWING, 0], "never asked", [], []),
    }

    def asker(self, tree=None, asked=None):
        tree = self.TREE if tree is None else tree

        def ask(paths):
            if asked is not None:
                asked.append(list(paths))
            return [tree.get(p) for p in paths]

        return ask

    def test_breadth_first_below_showing_nodes(self):
        asked = []
        nodes = h.walk_tree(self.asker(asked=asked))
        self.assertEqual([n["path"] for n in nodes], [ROOT, "/w", "/hidden", "/b", "/p"])
        self.assertEqual(asked, [[ROOT], ["/w", "/hidden"], ["/b", "/p"]])
        by = {n["path"]: n for n in nodes}
        self.assertEqual((by["/b"]["parent"], by["/b"]["index"], by["/b"]["name"]), ("/w", 0, "OK"))
        self.assertEqual((by["/p"]["index"], by["/w"]["children"]), (1, 3))
        self.assertEqual(by["/b"]["ifaces"], ["Accessible", "Component", "Action"])
        self.assertIsNone(by[ROOT]["parent"])

    def test_capped_by_nodes_and_by_time(self):
        self.assertEqual(len(h.walk_tree(self.asker(), max_nodes=2)), 2)
        ticks = iter([0, 0, 0, 1])
        self.assertEqual([n["path"] for n in h.walk_tree(self.asker(), clock=lambda: next(ticks))], [ROOT, "/w", "/hidden"])

    def test_gone_nodes_are_left_out(self):
        tree = dict(self.TREE)
        del tree["/w"]
        self.assertEqual([n["path"] for n in h.walk_tree(self.asker(tree))], [ROOT, "/hidden"])

    def test_what_a_cache_left_out_is_read_below_where_it_is_missing(self):
        # GTK4 caches the focused button and its ancestors: the box has 3 children, 1 of them cached.
        cached = [
            dict(node(ROOT, None), children=1),
            dict(node("/w", ROOT), children=1),
            dict(node("/box", "/w"), children=3),
            dict(node("/b", "/box"), index=0),
            dict(node("/list", "/w", states=(SHOWING | h.MANAGES_DESCENDANTS, 0)), children=9000),
            dict(node("/off", "/w", states=(0, 0)), children=4),
        ]
        start = h.incomplete(cached)
        self.assertEqual(start, [("/box", "/w", 0)])
        tree = {
            "/box": (39, [SHOWING, 0], "", ["Accessible", "Component"], ["/b", "/c", "/d"]),
            "/b": (43, [SHOWING, 0], "Alpha", ["Accessible"], ["/never"]),
            "/c": (43, [SHOWING, 0], "Bravo", ["Accessible"], ["/c/label"]),
            "/d": (43, [SHOWING, 0], "Charlie", ["Accessible"], []),
            "/c/label": (29, [SHOWING, 0], "Bravo", ["Accessible"], []),
        }
        asked = []
        walked = h.walk_tree(self.asker(tree, asked), start, known={n["path"] for n in cached})
        self.assertEqual([n["path"] for n in walked], ["/box", "/c", "/d", "/c/label"])
        self.assertEqual([(n["parent"], n["index"]) for n in walked[1:3]], [("/box", 1), ("/box", 2)])
        # The cached button isn't asked again, nor anything below it.
        self.assertNotIn("/b", sum(asked, []))


class Protocol(unittest.TestCase):
    def test_lines_come_whole(self):
        lines = h.Lines()
        self.assertEqual(lines.feed(b'{"id":1}\n{"id"'), [b'{"id":1}'])
        self.assertEqual(lines.feed(b":2}\n"), [b'{"id":2}'])
        self.assertEqual(lines.feed(b""), [])

    def test_bad_requests(self):
        desktop = h.Desktop()
        self.assertEqual(h.handle(desktop, b"not json")["code"], "bad_request")
        self.assertEqual(h.handle(desktop, b'{"op":"hello"}')["code"], "bad_request")
        reply = h.handle(desktop, b'{"id":7,"op":"shutdown"}')
        self.assertEqual((reply["id"], reply["ok"], reply["code"]), (7, False, "bad_request"))
        self.assertEqual(h.handle(desktop, b'{"id":8,"op":["hello"]}')["code"], "bad_request")

    def test_a_desktop_that_is_not_there(self):
        saved = os.environ.pop("DISPLAY", None)
        try:
            desktop = h.Desktop()
            reply = h.handle(desktop, json.dumps({"id": 1, "op": "snapshot", "scope": "front"}).encode())
            self.assertEqual((reply["id"], reply["ok"], reply["code"]), (1, False, "unavailable"))
            hello = h.handle(desktop, b'{"id":2,"op":"hello"}')["data"]
            self.assertEqual((hello["screen"], hello["a11y"]), (None, False))
            self.assertIn("problem", hello)
        finally:
            if saved is not None:
                os.environ["DISPLAY"] = saved

    def test_environ(self):
        self.assertEqual(h.parse_environ(b"A=1\0B=x=y\0junk\0\0"), {"A": "1", "B": "x=y"})


if __name__ == "__main__":
    unittest.main()
