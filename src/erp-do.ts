import { DurableObject } from "cloudflare:workers";
import {
	mergeStaffDirectory,
	sanitizeStaffMember,
	sha256Hex,
	simpleHash,
	verifyMasterPin,
	verifyStaffPin,
} from "./auth.ts";
import { SEED_DATA } from "./seed-data.ts";
import {
	COLLECTION_NAMES,
	type CollectionName,
	type CompanyKey,
	type CompanySettings,
	type ErpRecord,
	type ErpStateSnapshot,
	type PublicStaffMember,
	type SessionUser,
	type StaffMember,
	type SyncEventMessage,
	type SystemMeta,
} from "./types.ts";

interface RecordRow extends Record<string, SqlStorageValue> {
	collection: string;
	id: string;
	data: string;
	updated_at: number;
}

interface MetaRow extends Record<string, SqlStorageValue> {
	key: string;
	value: string;
	updated_at: number;
}

interface MediaRow extends Record<string, SqlStorageValue> {
	id: string;
	mime_type: string;
	data: ArrayBuffer;
	size: number;
	created_at: number;
}

function isTrialVikramCashRecord(c: ErpRecord): boolean {
	if (!c) return false;
	if (c.id === "COL_RCP_157" || c.receiptNo === "RCP-157") return true;
	const sp = String(c.salespersonName || "").toUpperCase();
	const bankRef = String(c.bankRef || "");
	const isVikram = sp.includes("VIKARAM") || sp.includes("VIKRAM") || bankRef.includes("Vikram");
	return c.mode === "Cash" && isVikram;
}

export class ErpLedgerDO extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.blockConcurrencyWhile(async () => {
			this.ctx.storage.sql.exec(`
				CREATE TABLE IF NOT EXISTS records (
					collection TEXT NOT NULL,
					id TEXT NOT NULL,
					data TEXT NOT NULL,
					updated_at INTEGER NOT NULL,
					PRIMARY KEY (collection, id)
				);
				CREATE INDEX IF NOT EXISTS idx_records_col ON records(collection);

				CREATE TABLE IF NOT EXISTS meta (
					key TEXT PRIMARY KEY,
					value TEXT NOT NULL,
					updated_at INTEGER NOT NULL
				);

				CREATE TABLE IF NOT EXISTS media (
					id TEXT PRIMARY KEY,
					mime_type TEXT NOT NULL,
					data BLOB NOT NULL,
					size INTEGER NOT NULL,
					created_at INTEGER NOT NULL
				);
			`);
		});
		this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
	}

	private getMeta<T>(key: string, fallback: T): T {
		const rows = this.ctx.storage.sql
			.exec<MetaRow>("SELECT key, value, updated_at FROM meta WHERE key = ?", key)
			.toArray();
		if (rows.length === 0) return fallback;
		try {
			return JSON.parse(rows[0].value) as T;
		} catch {
			return fallback;
		}
	}

	private setMeta(key: string, value: unknown): void {
		this.ctx.storage.sql.exec(
			"INSERT OR REPLACE INTO meta (key, value, updated_at) VALUES (?, ?, ?)",
			key,
			JSON.stringify(value),
			Date.now(),
		);
	}

	private getRev(): number {
		const raw = this.getMeta<number>("rev", 1);
		return Number(raw) || 1;
	}

	private bumpRev(): number {
		const next = this.getRev() + 1;
		this.setMeta("rev", next);
		return next;
	}

	private ensureSeeded(company: CompanyKey): void {
		const seededKey = `seeded_v1_${company}`;
		const already = this.getMeta<boolean>(seededKey, false);
		if (already) return;

		const now = Date.now();
		const seed = SEED_DATA[company.toLowerCase() as "madhav" | "shivom"];

		this.ctx.storage.transactionSync(() => {
			const insertCol = (col: CollectionName, items: ErpRecord[]) => {
				const seen = new Set<string>();
				for (const item of items) {
					if (!item || !item.id) continue;
					if (col === "collections" && isTrialVikramCashRecord(item)) continue;
					let uniqueId = String(item.id);
					let payload = item;
					if (seen.has(uniqueId)) {
						let suffix = 2;
						while (seen.has(`${uniqueId}_${suffix}`)) suffix++;
						uniqueId = `${uniqueId}_${suffix}`;
						payload = { ...item, id: uniqueId };
					}
					seen.add(uniqueId);
					this.ctx.storage.sql.exec(
						"INSERT OR IGNORE INTO records (collection, id, data, updated_at) VALUES (?, ?, ?, ?)",
						col,
						uniqueId,
						JSON.stringify(payload),
						now,
					);
				}
			};

			insertCol("parties", seed.parties || []);
			insertCol("products", seed.products || []);
			insertCol("orders", seed.orders || []);
			insertCol("collections", seed.collections || []);

			const mergedStaff = mergeStaffDirectory(seed.salespersons || []);
			insertCol("salespersons", mergedStaff);

			this.setMeta("company", company);
			this.setMeta("settings", {});
			this.setMeta("system", {});
			this.setMeta("rev", 1);
			this.setMeta(seededKey, true);
		});
	}

	private readCollection<T extends ErpRecord = ErpRecord>(collection: CollectionName): T[] {
		const rows = this.ctx.storage.sql
			.exec<RecordRow>(
				"SELECT collection, id, data, updated_at FROM records WHERE collection = ?",
				collection,
			)
			.toArray();
		const out: T[] = [];
		for (const row of rows) {
			try {
				out.push(JSON.parse(row.data) as T);
			} catch {
				// skip malformed row
			}
		}
		if (collection === "orders") {
			out.sort((a, b) => Number(b.orderNo || 0) - Number(a.orderNo || 0));
		}
		if (collection === "chatMessages") {
			out.sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0));
		}
		return out;
	}

	private broadcast(event: SyncEventMessage): void {
		const payload = JSON.stringify(event);
		for (const ws of this.ctx.getWebSockets()) {
			try {
				ws.send(payload);
			} catch {
				try {
					ws.close(1011, "Send failed");
				} catch {
					// ignore closed socket
				}
			}
		}
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
			const company = (url.searchParams.get("co") === "SHIVOM" ? "SHIVOM" : "MADHAV") as CompanyKey;
			this.ensureSeeded(company);

			const pair = new WebSocketPair();
			const client = pair[0];
			const server = pair[1];
			const userId = url.searchParams.get("uid") || "unknown";
			const role = url.searchParams.get("role") || "Staff";
			const name = url.searchParams.get("name") || "User";

			this.ctx.acceptWebSocket(server, [role, userId]);
			server.serializeAttachment({ userId, role, name, company, connectedAt: Date.now() });

			const welcome: SyncEventMessage = {
				type: "connected",
				company,
				rev: this.getRev(),
				ts: Date.now(),
			};
			server.send(JSON.stringify(welcome));

			return new Response(null, { status: 101, webSocket: client });
		}

		return new Response("ErpLedgerDO WebSocket endpoint", { status: 400 });
	}

	override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		if (typeof message !== "string") return;
		if (message === "ping") {
			ws.send("pong");
			return;
		}
		try {
			const data = JSON.parse(message) as { type?: string };
			if (data.type === "ping") {
				ws.send(JSON.stringify({ type: "pong", rev: this.getRev(), ts: Date.now() }));
			}
		} catch {
			// ignore non-JSON messages
		}
	}

	override async webSocketClose(
		ws: WebSocket,
		code: number,
		reason: string,
		_wasClean: boolean,
	): Promise<void> {
		try {
			ws.close(code, reason);
		} catch {
			// already closed
		}
	}

	override async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
		try {
			ws.close(1011, "WebSocket error");
		} catch {
			// ignore
		}
	}

	async getSnapshot(company: CompanyKey): Promise<ErpStateSnapshot> {
		this.ensureSeeded(company);
		const staffRaw = this.readCollection<StaffMember>("salespersons");
		const salespersons: PublicStaffMember[] =
			mergeStaffDirectory(staffRaw).map(sanitizeStaffMember);

		const collections = this.readCollection("collections").filter(
			(c) => !isTrialVikramCashRecord(c),
		);
		const cashHandovers = this.readCollection("cashHandovers").filter((h) => {
			const f = String(h.fromStaffName || "").toUpperCase();
			return !(f.includes("VIKARAM") || f.includes("VIKRAM"));
		});

		return {
			company,
			rev: this.getRev(),
			products: this.readCollection("products"),
			parties: this.readCollection("parties"),
			salespersons,
			orders: this.readCollection("orders"),
			collections,
			cashHandovers,
			bankDeposits: this.readCollection("bankDeposits"),
			purchaseBills: this.readCollection("purchaseBills"),
			salesReturns: this.readCollection("salesReturns"),
			expenses: this.readCollection("expenses"),
			chatMessages: this.readCollection("chatMessages"),
			settings: this.getMeta<CompanySettings>("settings", {}),
			system: this.getMeta<SystemMeta>("system", {}),
		};
	}

	async authenticateUser(
		company: CompanyKey,
		identifier: string,
		password: string,
		mode: "unified" | "owner" | "staff" = "unified",
	): Promise<{ ok: true; user: SessionUser } | { ok: false; error: string }> {
		this.ensureSeeded(company);
		const rawId = String(identifier || "").trim();
		const cleanPass = String(password || "").trim();
		const idLower = rawId.toLowerCase();
		const normalizedDigits = rawId.replace(/\D/g, "");
		const isAllowedShyamIdentifier =
			rawId === "9309543825" ||
			normalizedDigits === "9309543825" ||
			normalizedDigits === "919309543825" ||
			idLower === "madhaventerprises.care@gmail.com";

		const staffRaw = this.readCollection<StaffMember>("salespersons");
		const allStaff = mergeStaffDirectory(staffRaw);
		const dynamicOwner = allStaff.find((m) => m.id === "SP00") || null;
		const roshanOwner =
			allStaff.find(
				(m) =>
					m.id === "SP04" ||
					m.mobile === "9372376310" ||
					String(m.name || "")
						.toUpperCase()
						.includes("ROSHAN"),
			) || null;
		const isRoshanIdentifier =
			rawId === "9372376310" ||
			normalizedDigits === "9372376310" ||
			normalizedDigits === "919372376310" ||
			((mode === "unified" || mode === "owner") &&
				(idLower === "roshan" || idLower === "roshan thakre"));

		const buildOwnerResult = (): { ok: true; user: SessionUser } => ({
			ok: true,
			user: {
				id: dynamicOwner?.id || "SP00",
				name: dynamicOwner?.name || "SHYAM PIMPLKAR",
				role: "Owner",
				mobile: dynamicOwner?.mobile || "9309543825",
				area: dynamicOwner?.area || "Nagpur & Vidarbha H.O.",
				allowCash: true,
				isAdmin: true,
			},
		});

		const buildRoshanResult = (member: StaffMember): { ok: true; user: SessionUser } => ({
			ok: true,
			user: {
				id: member.id || "SP04",
				name: member.name || "ROSHAN THAKRE",
				role: member.role || "Owner",
				mobile: member.mobile || "9372376310",
				area: member.area || "Nagpur & Vidarbha H.O.",
				allowCash: true,
				isAdmin: true,
			},
		});

		if (mode === "owner") {
			if (!rawId || !cleanPass) {
				return {
					ok: false,
					error: "Please enter Owner Mobile or Email and Password / PIN.",
				};
			}
			if (isAllowedShyamIdentifier) {
				const ok = await verifyMasterPin(cleanPass, dynamicOwner);
				if (!ok) return { ok: false, error: "Invalid PIN. Access denied." };
				return buildOwnerResult();
			}
			if (isRoshanIdentifier && roshanOwner) {
				const ok = await verifyStaffPin(roshanOwner, cleanPass);
				if (!ok) return { ok: false, error: "Invalid Password. Access denied." };
				return buildRoshanResult(roshanOwner);
			}
			return {
				ok: false,
				error: "Owner login is restricted to registered Owner mobile or email credentials.",
			};
		}

		if (!rawId || !cleanPass) {
			return { ok: false, error: "Please enter both Username/Mobile and Password." };
		}

		if (isAllowedShyamIdentifier) {
			const ok = await verifyMasterPin(cleanPass, dynamicOwner);
			if (!ok) {
				return {
					ok: false,
					error: "Incorrect password or PIN for Owner Admin.",
				};
			}
			return buildOwnerResult();
		}

		if (isRoshanIdentifier && roshanOwner) {
			const ok = await verifyStaffPin(roshanOwner, cleanPass);
			if (!ok) {
				return {
					ok: false,
					error: `Incorrect password or PIN for ${roshanOwner.name}. Please try again.`,
				};
			}
			return buildRoshanResult(roshanOwner);
		}

		const nonAdminStaff = allStaff.filter((u) => {
			const upName = String(u.name || "").toUpperCase();
			return (
				u.id !== "SP00" &&
				u.id !== "SP04" &&
				u.role !== "Owner" &&
				u.role !== "Co-Owner" &&
				!upName.includes("SHYAM") &&
				!upName.includes("ROSHAN")
			);
		});
		const member = nonAdminStaff.find((u) => {
			const upName = String(u.name || "").toUpperCase();
			if (upName.includes("PRASHIK")) {
				return (
					u.mobile === rawId ||
					normalizedDigits === "7499477581" ||
					(mode === "unified" && idLower === "prashik")
				);
			}
			if (u.mobile === rawId) return true;
			if (mode !== "unified") return false;
			return (
				u.name.toLowerCase() === idLower ||
				(idLower === "gopal" && upName.includes("GOPAL")) ||
				((idLower === "vikram" || idLower === "vikaram") &&
					(upName.includes("VIKRAM") || upName.includes("VIKARAM")))
			);
		});

		if (!member) {
			return {
				ok: false,
				error:
					mode === "staff"
						? "Mobile number not registered in Team."
						: "Invalid Username or Password.",
			};
		}

		const match = await verifyStaffPin(member, cleanPass);
		if (!match) {
			return {
				ok: false,
				error: `Incorrect password or PIN for ${member.name}. Please try again.`,
			};
		}

		return {
			ok: true,
			user: {
				id: member.id,
				name: member.name,
				role: member.role || "Salesperson",
				mobile: member.mobile,
				area: member.area || "Field Route",
				allowCash: typeof member.allowCash !== "undefined" ? Boolean(member.allowCash) : true,
				isAdmin: false,
			},
		};
	}

	async upsertRecord(
		company: CompanyKey,
		collection: CollectionName,
		rawItem: ErpRecord,
		actor: string,
	): Promise<{ rev: number; item: ErpRecord }> {
		this.ensureSeeded(company);
		if (!rawItem || !rawItem.id) {
			throw new Error("Record id is required");
		}

		const item: ErpRecord = { ...rawItem };
		const id = String(item.id);

		// For salespersons, hash any plaintext PIN before storing and preserve existing hashes if PIN wasn't changed
		if (collection === "salespersons") {
			const staff = item as StaffMember;
			const existingRows = this.ctx.storage.sql
				.exec<RecordRow>(
					"SELECT collection, id, data, updated_at FROM records WHERE collection = 'salespersons' AND id = ?",
					id,
				)
				.toArray();
			const existing =
				existingRows.length > 0 ? (JSON.parse(existingRows[0].data) as StaffMember) : null;

			if (staff.pin && String(staff.pin).trim().length > 0) {
				const cleanPin = String(staff.pin).trim();
				staff.sha = (await sha256Hex(cleanPin)).toLowerCase();
				staff.simple = simpleHash(cleanPin);
				delete staff.pin;
			} else if (existing) {
				staff.sha = staff.sha || existing.sha;
				staff.simple = staff.simple || existing.simple;
				delete staff.pin;
			}
		}

		const now = Date.now();
		this.ctx.storage.sql.exec(
			"INSERT OR REPLACE INTO records (collection, id, data, updated_at) VALUES (?, ?, ?, ?)",
			collection,
			id,
			JSON.stringify(item),
			now,
		);
		const rev = this.bumpRev();

		const publicItem =
			collection === "salespersons"
				? (sanitizeStaffMember(item as StaffMember) as unknown as ErpRecord)
				: item;
		this.broadcast({
			type: "upsert",
			company,
			collection,
			id,
			item: publicItem,
			rev,
			actor,
			ts: now,
		});

		return { rev, item: publicItem };
	}

	async deleteRecord(
		company: CompanyKey,
		collection: CollectionName,
		id: string,
		actor: string,
	): Promise<{ rev: number }> {
		this.ensureSeeded(company);
		this.ctx.storage.sql.exec(
			"DELETE FROM records WHERE collection = ? AND id = ?",
			collection,
			id,
		);
		const rev = this.bumpRev();
		this.broadcast({
			type: "delete",
			company,
			collection,
			id,
			rev,
			actor,
			ts: Date.now(),
		});
		return { rev };
	}

	async updateSettings(
		company: CompanyKey,
		patch: CompanySettings,
		actor: string,
	): Promise<{ rev: number; settings: CompanySettings }> {
		this.ensureSeeded(company);
		const current = this.getMeta<CompanySettings>("settings", {});
		const next = { ...current, ...patch };
		this.setMeta("settings", next);
		const rev = this.bumpRev();
		this.broadcast({
			type: "settings",
			company,
			settings: next,
			rev,
			actor,
			ts: Date.now(),
		});
		return { rev, settings: next };
	}

	async bulkImport(
		company: CompanyKey,
		collections: Partial<Record<CollectionName, ErpRecord[]>>,
		mode: "merge" | "replace",
		actor: string,
	): Promise<{ rev: number }> {
		this.ensureSeeded(company);
		const now = Date.now();
		const prepared: Partial<Record<CollectionName, ErpRecord[]>> = {};
		for (const col of COLLECTION_NAMES) {
			const items = collections[col];
			if (!Array.isArray(items)) continue;
			if (col === "salespersons") {
				const hashed: ErpRecord[] = [];
				for (const raw of items) {
					if (!raw || !raw.id) continue;
					const copy = { ...raw } as StaffMember;
					if (copy.pin && String(copy.pin).trim()) {
						copy.sha = (await sha256Hex(String(copy.pin).trim())).toLowerCase();
						copy.simple = simpleHash(String(copy.pin).trim());
						delete copy.pin;
					}
					hashed.push(copy);
				}
				prepared[col] = hashed;
			} else {
				prepared[col] = items;
			}
		}

		let rev = 1;
		this.ctx.storage.transactionSync(() => {
			for (const col of COLLECTION_NAMES) {
				const items = prepared[col];
				if (!items) continue;
				if (mode === "replace") {
					this.ctx.storage.sql.exec("DELETE FROM records WHERE collection = ?", col);
				}
				for (const raw of items) {
					if (!raw || !raw.id) continue;
					this.ctx.storage.sql.exec(
						"INSERT OR REPLACE INTO records (collection, id, data, updated_at) VALUES (?, ?, ?, ?)",
						col,
						String(raw.id),
						JSON.stringify(raw),
						now,
					);
				}
			}
			rev = this.bumpRev();
		});
		this.broadcast({ type: "reload", company, rev, actor, ts: now });
		return { rev };
	}

	async clearData(
		company: CompanyKey,
		scope: "transactions" | "all",
		resetPartyOpening: boolean,
		actor: string,
	): Promise<{ rev: number; resetAt: number }> {
		this.ensureSeeded(company);
		const colsToClear: CollectionName[] =
			scope === "all"
				? [
						"products",
						"parties",
						"orders",
						"collections",
						"cashHandovers",
						"bankDeposits",
						"purchaseBills",
						"salesReturns",
						"expenses",
					]
				: [
						"orders",
						"collections",
						"cashHandovers",
						"bankDeposits",
						"purchaseBills",
						"salesReturns",
						"expenses",
					];

		const resetAt = Date.now();
		let rev = 1;
		this.ctx.storage.transactionSync(() => {
			for (const col of colsToClear) {
				this.ctx.storage.sql.exec("DELETE FROM records WHERE collection = ?", col);
			}
			if (scope === "transactions" && resetPartyOpening) {
				const parties = this.readCollection("parties");
				for (const p of parties) {
					p.openingBalance = 0;
					this.ctx.storage.sql.exec(
						"INSERT OR REPLACE INTO records (collection, id, data, updated_at) VALUES ('parties', ?, ?, ?)",
						String(p.id),
						JSON.stringify(p),
						resetAt,
					);
				}
			}
			const systemMeta: SystemMeta = {
				resetAt,
				scope,
				clearedCollections: colsToClear,
				resetPartyOpening,
				clearedBy: actor,
			};
			this.setMeta("system", systemMeta);
			rev = this.bumpRev();
		});

		this.broadcast({
			type: "clear",
			company,
			scope,
			resetPartyOpening,
			resetAt,
			rev,
			actor,
			ts: resetAt,
		});

		return { rev, resetAt };
	}

	async saveMedia(
		company: CompanyKey,
		id: string,
		mimeType: string,
		bytes: Uint8Array,
	): Promise<{ id: string; size: number }> {
		this.ensureSeeded(company);
		if (bytes.byteLength > 2 * 1024 * 1024) {
			throw new Error("Compressed media exceeds 2 MB limit");
		}
		this.ctx.storage.sql.exec(
			"INSERT OR REPLACE INTO media (id, mime_type, data, size, created_at) VALUES (?, ?, ?, ?, ?)",
			id,
			mimeType,
			bytes,
			bytes.byteLength,
			Date.now(),
		);
		return { id, size: bytes.byteLength };
	}

	async getMedia(
		company: CompanyKey,
		id: string,
	): Promise<{ mimeType: string; data: Uint8Array } | null> {
		this.ensureSeeded(company);
		const rows = this.ctx.storage.sql
			.exec<MediaRow>("SELECT id, mime_type, data, size, created_at FROM media WHERE id = ?", id)
			.toArray();
		if (rows.length === 0) return null;
		const row = rows[0];
		return {
			mimeType: row.mime_type,
			data: new Uint8Array(row.data),
		};
	}

	async getPublicDocument(
		company: CompanyKey,
		viewType: string,
		id?: string | null,
		partyId?: string | null,
		date?: string | null,
	): Promise<{
		found: boolean;
		company: CompanyKey;
		viewType: string;
		settings: CompanySettings;
		order?: ErpRecord;
		collection?: ErpRecord;
		party?: ErpRecord;
		partyOrders?: ErpRecord[];
		partyCollections?: ErpRecord[];
		partyReturns?: ErpRecord[];
		summaryOrders?: ErpRecord[];
		summaryCollections?: ErpRecord[];
		summaryExpenses?: ErpRecord[];
		summaryParties?: ErpRecord[];
	}> {
		this.ensureSeeded(company);
		const settings = this.getMeta<CompanySettings>("settings", {});
		const parties = this.readCollection("parties");
		const orders = this.readCollection("orders");
		const collections = this.readCollection("collections").filter(
			(c) => !isTrialVikramCashRecord(c),
		);

		if (viewType === "invoice" || viewType === "memo" || viewType === "challan") {
			const ord = orders.find(
				(o) => o.id === id || String(o.orderNo) === String(id) || o.memoNo === id,
			);
			if (!ord) {
				return { found: false, company, viewType, settings };
			}
			const party =
				parties.find(
					(p) =>
						p.id === ord.partyId ||
						(ord.partyName &&
							String(p.name || "")
								.trim()
								.toUpperCase() === String(ord.partyName).trim().toUpperCase()),
				) || undefined;
			return { found: true, company, viewType, settings, order: ord, party };
		}

		if (viewType === "receipt") {
			const col = collections.find((c) => c.id === id || c.receiptNo === id);
			if (!col) {
				return { found: false, company, viewType, settings };
			}
			const party =
				parties.find(
					(p) =>
						p.id === col.partyId ||
						(col.partyName &&
							String(p.name || "")
								.trim()
								.toUpperCase() === String(col.partyName).trim().toUpperCase()),
				) || undefined;
			return { found: true, company, viewType, settings, collection: col, party };
		}

		if (viewType === "statement") {
			const target = partyId || id;
			const party = parties.find(
				(p) =>
					p.id === target ||
					String(p.name || "")
						.trim()
						.toUpperCase() ===
						String(target || "")
							.trim()
							.toUpperCase(),
			);
			if (!party) {
				return { found: false, company, viewType, settings };
			}
			const pUpper = String(party.name || "")
				.trim()
				.toUpperCase();
			const partyOrders = orders.filter(
				(o) =>
					o.partyId === party.id ||
					String(o.partyName || "")
						.trim()
						.toUpperCase() === pUpper,
			);
			const partyCollections = collections.filter(
				(c) =>
					c.partyId === party.id ||
					String(c.partyName || "")
						.trim()
						.toUpperCase() === pUpper,
			);
			const salesReturns = this.readCollection("salesReturns");
			const partyReturns = salesReturns.filter(
				(r) =>
					r.partyId === party.id ||
					String(r.partyName || "")
						.trim()
						.toUpperCase() === pUpper,
			);
			return {
				found: true,
				company,
				viewType,
				settings,
				party,
				partyOrders,
				partyCollections,
				partyReturns,
			};
		}

		if (viewType === "summary") {
			const targetDate = String(date || id || new Date().toISOString().split("T")[0]).slice(0, 10);
			const expenses = this.readCollection("expenses");
			return {
				found: true,
				company,
				viewType,
				settings,
				summaryOrders: orders.filter((o) => String(o.date || "").slice(0, 10) === targetDate),
				summaryCollections: collections.filter(
					(c) => String(c.date || "").slice(0, 10) === targetDate,
				),
				summaryExpenses: expenses.filter((e) => String(e.date || "").slice(0, 10) === targetDate),
				summaryParties: parties,
			};
		}

		return { found: false, company, viewType, settings };
	}
}
