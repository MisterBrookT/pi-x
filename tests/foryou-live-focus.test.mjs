import test from "node:test";
import assert from "node:assert/strict";
import { createLiveFocus } from "../plugins/foryou/live-focus.ts";

function fixture() {
	let rows = [{ id: "a" }, { id: "b" }, { id: "c" }],
		renders = 0,
		gone = 0;
	const actions = [];
	const focus = createLiveFocus({
		rows: () => rows,
		render: () => renders++,
		act: (id, verb) => actions.push([id, verb]),
		gone: () => gone++,
	});
	return {
		focus,
		actions,
		rows: (v) => (rows = v),
		renders: () => renders,
		gone: () => gone,
	};
}

test("unfocused keys remain editor input; opening selects the first live row", () => {
	const f = fixture();
	assert.equal(f.focus.handleInput("s"), undefined);
	assert.equal(f.focus.focus(), true);
	assert.equal(f.focus.selectedId, "a");
	assert.equal(f.renders(), 1);
});

test("arrows and numbers select without acting; Enter does it once", () => {
	const f = fixture();
	f.focus.focus();
	assert.deepEqual(f.focus.handleInput("\x1b[B"), { consume: true });
	assert.equal(f.focus.selectedId, "b");
	f.focus.handleInput("3");
	assert.equal(f.focus.selectedId, "c");
	assert.deepEqual(f.actions, []);
	f.focus.handleInput("\r");
	assert.deepEqual(f.actions, [["c", "do"]]);
	assert.equal(f.focus.selectedId, undefined);
});

test("s and l no longer act on the Mac list (only Enter do and d remove)", () => {
	const f = fixture();
	f.focus.focus();
	for (const k of ["s", "l"]) assert.deepEqual(f.focus.handleInput(k), { consume: true });
	assert.deepEqual(f.actions, []);
});

test("Escape returns focus without action; unknown keys cannot modify the editor while focused", () => {
	const f = fixture();
	f.focus.focus();
	assert.deepEqual(f.focus.handleInput("x"), { consume: true });
	f.focus.handleInput("\x1b");
	assert.equal(f.focus.selectedId, undefined);
	assert.deepEqual(f.actions, []);
	assert.equal(f.focus.handleInput("x"), undefined);
});

test("selection follows stable ids when the phone removes an earlier row", () => {
	const f = fixture();
	f.focus.focus();
	f.focus.handleInput("2");
	f.rows([{ id: "b" }, { id: "c" }]);
	f.focus.handleInput("\r");
	assert.deepEqual(f.actions, [["b", "do"]]);
});

test("an ask handled on the phone cannot turn Enter into a different ask's reply", () => {
	const f = fixture();
	f.focus.focus();
	f.rows([{ id: "b" }]);
	f.focus.handleInput("\r");
	assert.deepEqual(f.actions, []);
	assert.equal(f.focus.selectedId, undefined);
	assert.equal(f.gone(), 1);
});

test("Kitty key releases are consumed without moving or executing a second action", () => {
	const f = fixture();
	f.focus.focus();
	f.focus.handleInput("\x1b[57364;1:3u");
	assert.equal(f.focus.selectedId, "a");
	f.focus.handleInput("\x1b[108;1:3u");
	assert.deepEqual(f.actions, []);
});

test("no live rows means focus stays with the editor; Ctrl+C remains an application control", () => {
	const f = fixture();
	f.rows([]);
	assert.equal(f.focus.focus(), false);
	f.rows([{ id: "a" }]);
	f.focus.focus();
	assert.equal(f.focus.handleInput("\x03"), undefined);
	assert.equal(f.focus.selectedId, undefined);
	assert.deepEqual(f.actions, []);
});
