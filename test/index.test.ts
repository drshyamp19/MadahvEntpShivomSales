import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";

async function loginAs(
	identifier: string,
	password: string,
	mode: "unified" | "owner" | "staff" = "unified",
) {
	const res = await SELF.fetch(
		"https://madhav-enterprises.madhavshivom.workers.dev/api/auth/login",
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ identifier, password, mode }),
		},
	);
	const data = (await res.json()) as {
		ok: boolean;
		token?: string;
		user?: { id: string; name: string; role: string; isAdmin: boolean; allowCash: boolean };
		error?: string;
	};
	return { res, data };
}

describe("Madhav & Shivom Cloudflare-Only ERP", () => {
	it("serves brand-specific HTML meta and manifests for MADHAV and SHIVOM", async () => {
		const madhavHtmlRes = await SELF.fetch("https://madhav-enterprises.madhavshivom.workers.dev/");
		expect(madhavHtmlRes.status).toBe(200);
		const madhavHtml = await madhavHtmlRes.text();
		expect(madhavHtml).toContain("MADHAV ENTERPRISES - Cloud ERP Portal");
		expect(madhavHtml).toContain("/madhav-logo.png");
		expect(madhavHtml).not.toContain("firebase-app-compat");

		const shivomViewRes = await SELF.fetch(
			"https://madhav-enterprises.madhavshivom.workers.dev/?view=invoice&id=ORD_106_P004&co=SHIVOM",
		);
		expect(shivomViewRes.status).toBe(200);
		const shivomHtml = await shivomViewRes.text();
		expect(shivomHtml).toContain("SHIVOM SALES &amp; SERVICES - Cloud ERP Portal");
		expect(shivomHtml).toContain("/shivom-logo-cropped.png");

		const shivomManifestRes = await SELF.fetch(
			"https://shivom-sales.madhavshivom.workers.dev/manifest.json",
		);
		expect(shivomManifestRes.status).toBe(200);
		const shivomManifest = (await shivomManifestRes.json()) as {
			short_name: string;
			theme_color: string;
		};
		expect(shivomManifest.short_name).toBe("Shivom ERP");
		expect(shivomManifest.theme_color).toBe("#0f766e");

		const swRes = await SELF.fetch("https://madhav-enterprises.madhavshivom.workers.dev/sw.js");
		expect(swRes.status).toBe(200);
		const swText = await swRes.text();
		expect(swText).toContain("/api/");
		expect(swText).not.toContain("firestore");
	});

	it("enforces authentication and role permissions on API routes", async () => {
		const unauthRes = await SELF.fetch(
			"https://madhav-enterprises.madhavshivom.workers.dev/api/state?co=MADHAV",
		);
		expect(unauthRes.status).toBe(401);

		const badLogin = await loginAs("admin", "wrong-pin", "unified");
		expect(badLogin.res.status).toBe(401);
		expect(badLogin.data.ok).toBe(false);

		const ownerLogin = await loginAs("admin", "9850", "unified");
		expect(ownerLogin.res.status).toBe(200);
		expect(ownerLogin.data.ok).toBe(true);
		expect(ownerLogin.data.user?.isAdmin).toBe(true);
		expect(ownerLogin.data.token).toBeTruthy();

		// Owner creates a restricted salesperson and verifies server-side cash restriction + admin-only routes
		const addStaffRes = await SELF.fetch(
			"https://madhav-enterprises.madhavshivom.workers.dev/api/records/salespersons?co=SHIVOM",
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${ownerLogin.data.token}`,
				},
				body: JSON.stringify({
					id: "SP_TEST_RESTRICTED",
					name: "TEST FIELD STAFF",
					mobile: "9999988888",
					role: "Salesperson",
					area: "Nagpur",
					allowCash: false,
					pin: "4321",
					active: true,
				}),
			},
		);
		expect(addStaffRes.status).toBe(200);

		const staffLogin = await loginAs("9999988888", "4321", "staff");
		expect(staffLogin.res.status).toBe(200);
		expect(staffLogin.data.user?.isAdmin).toBe(false);
		expect(staffLogin.data.user?.allowCash).toBe(false);

		// Restricted staff cannot record Cash collections
		const cashRes = await SELF.fetch(
			"https://madhav-enterprises.madhavshivom.workers.dev/api/records/collections?co=SHIVOM",
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${staffLogin.data.token}`,
				},
				body: JSON.stringify({
					id: "COL_TEST_DENIED",
					mode: "Cash",
					amount: 500,
					partyName: "TEST",
				}),
			},
		);
		expect(cashRes.status).toBe(403);

		// Non-admin staff cannot clear data
		const clearRes = await SELF.fetch(
			"https://madhav-enterprises.madhavshivom.workers.dev/api/clear?co=SHIVOM",
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${staffLogin.data.token}`,
				},
				body: JSON.stringify({ scope: "transactions" }),
			},
		);
		expect(clearRes.status).toBe(403);
	});

	it("auto-seeds MADHAV and SHIVOM into separate SQLite Durable Objects without leaking secrets", async () => {
		const { data: auth } = await loginAs("admin", "9850", "unified");
		const token = auth.token!;

		const madhavRes = await SELF.fetch(
			"https://madhav-enterprises.madhavshivom.workers.dev/api/state?co=MADHAV",
			{
				headers: { Authorization: `Bearer ${token}` },
			},
		);
		expect(madhavRes.status).toBe(200);
		const madhav = (await madhavRes.json()) as {
			company: string;
			parties: Array<{ openingBalance?: number }>;
			products: unknown[];
			salespersons: Array<{ sha?: string; simple?: number; pin?: string }>;
		};
		expect(madhav.company).toBe("MADHAV");
		expect(madhav.parties.length).toBe(560);
		expect(madhav.products.length).toBe(29);
		const openingSum = madhav.parties.reduce((acc, p) => acc + (Number(p.openingBalance) || 0), 0);
		expect(openingSum).toBe(1066177);
		for (const sp of madhav.salespersons) {
			expect(sp.sha).toBeUndefined();
			expect(sp.simple).toBeUndefined();
			expect(sp.pin).toBeUndefined();
		}

		const shivomRes = await SELF.fetch(
			"https://madhav-enterprises.madhavshivom.workers.dev/api/state?co=SHIVOM",
			{
				headers: { Authorization: `Bearer ${token}` },
			},
		);
		expect(shivomRes.status).toBe(200);
		const shivom = (await shivomRes.json()) as {
			company: string;
			parties: unknown[];
			products: unknown[];
			orders: unknown[];
			collections: unknown[];
		};
		expect(shivom.company).toBe("SHIVOM");
		expect(shivom.parties.length).toBe(63);
		expect(shivom.products.length).toBe(11);
		expect(shivom.orders.length).toBe(44);
		expect(shivom.collections.length).toBe(57);
	});

	it("stores proof photos in DO SQLite, serves public ?view= docs, and broadcasts real-time WebSocket updates", async () => {
		const { data: auth } = await loginAs("admin", "9850", "unified");
		const token = auth.token!;

		// 1. Public ?view= endpoints (unauthenticated)
		const pubInv = await SELF.fetch(
			"https://shivom-sales.madhavshivom.workers.dev/api/public/view?view=invoice&id=ORD_106_P004&co=SHIVOM",
		);
		expect(pubInv.status).toBe(200);
		const pubInvData = (await pubInv.json()) as { ok: boolean; order?: { orderNo: string } };
		expect(pubInvData.ok).toBe(true);
		expect(pubInvData.order?.orderNo).toBe("106");

		const pubStmt = await SELF.fetch(
			"https://shivom-sales.madhavshivom.workers.dev/api/public/view?view=statement&partyId=P001&co=SHIVOM",
		);
		expect(pubStmt.status).toBe(200);
		const pubStmtData = (await pubStmt.json()) as { ok: boolean; party?: { id: string } };
		expect(pubStmtData.ok).toBe(true);
		expect(pubStmtData.party?.id).toBe("P001");

		// 2. Upload & retrieve compressed proof photo in DO media table
		const tinyPngDataUrl =
			"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
		const mediaRes = await SELF.fetch(
			"https://madhav-enterprises.madhavshivom.workers.dev/api/media?co=SHIVOM",
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${token}`,
				},
				body: JSON.stringify({
					id: "test_proof_1",
					dataUrl: tinyPngDataUrl,
					mimeType: "image/png",
				}),
			},
		);
		expect(mediaRes.status).toBe(200);
		const mediaJson = (await mediaRes.json()) as { ok: boolean; url: string };
		expect(mediaJson.ok).toBe(true);

		const fetchedMedia = await SELF.fetch(
			`https://madhav-enterprises.madhavshivom.workers.dev${mediaJson.url}`,
		);
		expect(fetchedMedia.status).toBe(200);
		expect(fetchedMedia.headers.get("Content-Type")).toBe("image/png");
		await fetchedMedia.arrayBuffer();

		// 3. WebSocket Hibernation real-time sync broadcast
		const wsRes = await SELF.fetch(
			`https://madhav-enterprises.madhavshivom.workers.dev/api/ws?co=MADHAV&token=${encodeURIComponent(token)}`,
			{
				headers: { Upgrade: "websocket" },
			},
		);
		expect(wsRes.status).toBe(101);
		const ws = wsRes.webSocket;
		expect(ws).toBeTruthy();
		ws!.accept();

		const received: string[] = [];
		const gotUpsert = new Promise<void>((resolve) => {
			ws!.addEventListener("message", (ev) => {
				const text = typeof ev.data === "string" ? ev.data : "";
				received.push(text);
				if (text.includes("ORD_WS_TEST_1")) {
					resolve();
				}
			});
		});

		const saveRes = await SELF.fetch(
			"https://madhav-enterprises.madhavshivom.workers.dev/api/records/orders?co=MADHAV",
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${token}`,
				},
				body: JSON.stringify({
					id: "ORD_WS_TEST_1",
					orderNo: "999",
					memoNo: "OB-999",
					date: "2026-11-25",
					partyId: "MP0001",
					partyName: "A to z appliances",
					orderQty: 2,
					dispatchedQty: 0,
					totalAmt: 2170,
				}),
			},
		);
		expect(saveRes.status).toBe(200);
		await gotUpsert;
		expect(received.some((m) => m.includes('"type":"upsert"') && m.includes("ORD_WS_TEST_1"))).toBe(
			true,
		);
		ws!.close();
	});
});
