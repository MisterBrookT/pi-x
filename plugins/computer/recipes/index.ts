/**
 * Saved, tested computer-use scripts ("recipes"). A recipe is an ordinary async function over the same
 * `cua` a script gets, so the target guard, action budget and irreversible-act confirm all still apply:
 * a recipe can do nothing a hand-written script could not. Call one with `cua.recipe(name, args)`.
 * Add one: write `recipes/<app>.ts`, export a Recipe, list it below, and test it with a fake screen.
 */
import type { CuaApi } from "../computer-script.ts";
import type { ScreenOperations } from "../computer-screen.ts";
import { wechatFind, wechatSend } from "./wechat.ts";

export interface RecipeContext { cua: CuaApi; screen?: ScreenOperations }
export interface Recipe {
	/** One line for the tool description. */
	about: string;
	run(ctx: RecipeContext, args: Record<string, unknown>): Promise<unknown>;
}

export const recipes: Record<string, Recipe> = {
	"wechat-send": wechatSend,
	"wechat-find": wechatFind,
};

export const recipeList = () => Object.entries(recipes).map(([name, r]) => `${name}: ${r.about}`).join("\n");
