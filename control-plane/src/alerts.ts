// Telegram alerts (Decision: alert channel). Each carries job_id, error and the last 5 events.
import { lastEvents } from "./db";

export async function alert(env: Env, db: D1Database | null, text: string, jobId?: string) {
	let msg = `Video Factory: ${text}`;
	if (jobId && db) {
		const ev = await lastEvents(db, jobId, 5);
		msg += `\njob ${jobId}\n` + ev.map((e) => `${new Date(e.ts).toISOString().slice(11, 19)} ${e.kind} ${e.data_json ?? ""}`.slice(0, 200)).join("\n");
	}
	if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
		console.warn("alert (Telegram not configured):", msg);
		return;
	}
	try {
		await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: msg.slice(0, 4000) }),
		});
	} catch (e) {
		console.error("telegram alert failed", e);
	}
}
