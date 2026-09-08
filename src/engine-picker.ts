// First-run onboarding: the engine picker plus the agy-presence warning.
//
// On the first interactive start (no config file yet, no AGY_ENGINE env) pi
// asks which turn engine to use: the stream-json `agy` CLI or Google's
// official ACP server. The choice persists via saveConfig({ engine }) and,
// like /agy engine, takes effect on the next pi start (drivers wire at load).
// Every start with the stream-json engine active also re-checks that the
// `agy` binary exists and warns until it does (re-auth is out of scope).
//
// UI: tui.md "Pattern 1" - SelectList framed by DynamicBorder inside pi's
// native overlay (the window feel pi-rtk builds its modal on).

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
	Container,
	type SelectItem,
	SelectList,
	Spacer,
	Text,
} from "@earendil-works/pi-tui";
import fs from "node:fs";
import path from "node:path";
import type { Engine } from "./config.js";

/** Picker order is the default answer order: stream-json first. */
export const ENGINE_PICKER_ITEMS: SelectItem[] = [
	{
		value: "stream-json",
		label: "Stream-JSON CLI",
		description: "default, recommended",
	},
	{
		value: "acp",
		label: "ACP server (official Google)",
		description: "second sign-in, ~1.5 GB binary download",
	},
];

/** Intro paragraph above the list. Text wraps, so explanations stay here and
 *  SelectItem descriptions stay one-liners (SelectList truncates long lines). */
export const ENGINE_PICKER_INTRO = [
	"Pick the engine that runs your Antigravity turns. Switch anytime with /agy engine (restart applies it).",
	"",
	"stream-json: the `agy` CLI you already installed and authenticated. Persistent process, streamed output. Tested default.",
	"ACP: Google's official server (agy_acp_server.par). Needs a second Google sign-in and a ~1.5 GB server binary downloaded from Google (automatic, one-time, unavoidable: the server is not part of the agy CLI).",
].join("\n");

/** True only for a genuine first interactive run: no saved config yet (any
 *  existing file means the user has been here before) and no AGY_ENGINE env
 *  (env wins over the file, so the wizard would fight it). Fails closed to
 *  false - an fs error must never nag the user with a dialog. */
export function shouldOfferEnginePicker(
	configPath: string,
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	if (env.AGY_ENGINE !== undefined) return false;
	try {
		return !fs.existsSync(configPath);
	} catch {
		return false;
	}
}

/** Narrow a picker value to an Engine. Items are our own constants, but an
 *  unknown value must never reach config as a cast string: it falls back to
 *  the tested default. */
export function toEngine(value: string): Engine {
	return value === "acp" ? "acp" : "stream-json";
}

/** Toast copy shown after the choice is saved. ACP names the promise that
 *  matters: the binary download starts NOW (not on restart), sign-in follows
 *  when it lands, restart applies the engine. */
export function savedEngineMessage(engine: Engine): string {
	return engine === "acp"
		? "Engine saved: acp. The ~1.5 GB server binary downloads now; the Google sign-in opens when it lands. Restart applies the engine."
		: "Engine saved: stream-json. Restart pi to apply.";
}

/** True when the `agy` CLI binary can be found. A binRef with a path
 *  separator (AGY_BIN=/opt/agy/agy) must exist as a file; a bare name is
 *  searched on PATH. statSync cannot throw through the guards, but a race
 *  (file removed between listing and stat) fails closed to false. */
export function isAgyInstalled(binRef: string, env: NodeJS.ProcessEnv = process.env): boolean {
	if (binRef.includes("/")) {
		try {
			return fs.statSync(binRef).isFile();
		} catch {
			return false;
		}
	}
	return (env.PATH ?? "")
		.split(path.delimiter)
		.filter(Boolean)
		.some((dir) => {
			try {
				return fs.statSync(path.join(dir, binRef)).isFile();
			} catch {
				return false;
			}
		});
}

/** Toast copy for the missing-CLI warning. Fires every pi start while the
 *  stream-json engine is active and the binary is absent. */
export function agyMissingMessage(): string {
	return "The `agy` CLI is not installed. Install it from https://antigravity.google/product/antigravity-cli and log in on it to use Antigravity models.";
}

/** Render the picker overlay. Resolves with the chosen engine, or null when
 *  the user pressed esc (decide later - nothing is persisted). */
export async function showEnginePicker(ctx: ExtensionUIContext): Promise<Engine | null> {
	return ctx.custom<Engine | null>(
		(tui, theme, _keybindings, done) => {
			const container = new Container();
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			container.addChild(
				new Text(theme.fg("accent", theme.bold("Antigravity Bridge: choose your engine")), 1, 0),
			);
			container.addChild(new Text(theme.fg("muted", ENGINE_PICKER_INTRO), 1, 0));
			container.addChild(new Spacer(1));

			const list = new SelectList(ENGINE_PICKER_ITEMS, ENGINE_PICKER_ITEMS.length, {
				selectedPrefix: (t: string) => theme.fg("accent", t),
				selectedText: (t: string) => theme.fg("accent", t),
				description: (t: string) => theme.fg("muted", t),
				scrollInfo: (t: string) => theme.fg("dim", t),
				noMatch: (t: string) => theme.fg("warning", t),
			});
			list.onSelect = (item) => done(toEngine(item.value));
			list.onCancel = () => done(null);
			container.addChild(list);

			container.addChild(new Spacer(1));
			container.addChild(
				new Text(theme.fg("dim", "↑↓ navigate · enter select · esc decide later"), 1, 0),
			);
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

			return {
				render: (width: number) => container.render(width),
				invalidate: () => container.invalidate(),
				handleInput: (data: string) => {
					list.handleInput(data);
					tui.requestRender();
				},
			};
		},
		{
			overlay: true,
			overlayOptions: { anchor: "center" as const, width: 80, maxHeight: "85%" as const, margin: 1 },
		},
	);
}
