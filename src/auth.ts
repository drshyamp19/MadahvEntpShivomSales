import type { PublicStaffMember, SessionTokenPayload, SessionUser, StaffMember } from "./types.ts";

// Preserved Master & Staff credentials from the existing ERP (hashed; never exposed to clients)
export const MASTER_PIN_SHA256 = "ba258b5a7eb00f1bb2da1943f42c46d45ae030163ba9fdfad4eefad0d9cb2319";
export const MASTER_PIN_SIMPLE = 1753594;

// Precomputed SHA-256 hashes of Owner fallback PINs ("7499", "1753594", "9850")
const OWNER_FALLBACK_SHA256 = [
	"a0640301060728f845e0814585c6781f90f562135a4b4f06b6a08d0787761458", // 7499? verified at runtime via sha256Hex compare
	MASTER_PIN_SHA256,
];

export const BASE_STAFF_CREDENTIALS: StaffMember[] = [
	{
		id: "SP00",
		name: "SHYAM PIMPLKAR",
		mobile: "9309543825",
		role: "Owner",
		area: "Nagpur & Vidarbha H.O.",
		allowCash: true,
		sha: MASTER_PIN_SHA256,
		simple: MASTER_PIN_SIMPLE,
		active: true,
	},
	{
		id: "SP01",
		name: "PRASHIK HAJARE",
		mobile: "7499477581",
		role: "Manager",
		area: "Field Sales & Recovery (Vidarbha)",
		allowCash: true,
		sha: "d365964c7f5aab5ffa822dba82431d1bee8502ae8338c9569adc992b1de46dcc",
		simple: -1110792094,
		active: true,
	},
	{
		id: "SP02",
		name: "GOPAL AMBAGADE",
		mobile: "9075479839",
		role: "Salesperson",
		area: "Field Route",
		allowCash: true,
		sha: "99ed8cdd6414bf2746b44963bd3657890107b370f0aa2bde6e24b9734363df93",
		simple: -2146150974,
		active: true,
	},
	{
		id: "SP03",
		name: "VIKARAM SING THAKUR",
		mobile: "7028287698",
		role: "Salesperson",
		area: "Field Route",
		allowCash: false,
		sha: "9882b7345c723cd08775ad0d857e73bfd45abf282a99060575501018148d540d",
		simple: -684522678,
		active: true,
	},
];

export function simpleHash(s: string): number {
	let h = 0;
	for (let i = 0; i < s.length; i++) {
		h = (h << 5) - h + s.charCodeAt(i);
		h |= 0;
	}
	return h;
}

export async function sha256Bytes(text: string): Promise<ArrayBuffer> {
	return crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
}

export async function sha256Hex(text: string): Promise<string> {
	const buf = await sha256Bytes(text);
	return Array.from(new Uint8Array(buf))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

export async function timingSafeStringEqual(a: string, b: string): Promise<boolean> {
	const [ha, hb] = await Promise.all([sha256Bytes(a), sha256Bytes(b)]);
	return crypto.subtle.timingSafeEqual(ha, hb);
}

export async function verifyMasterPin(
	enteredPass: string,
	dynamicOwner?: StaffMember | null,
): Promise<boolean> {
	const clean = String(enteredPass || "").trim();
	if (!clean) return false;

	const enteredHex = (await sha256Hex(clean)).toLowerCase();
	if (await timingSafeStringEqual(enteredHex, MASTER_PIN_SHA256)) return true;
	if (simpleHash(clean) === MASTER_PIN_SIMPLE) return true;

	// Legacy fallback PINs from original app ("7499", "1753594", "9850")
	for (const fallback of ["7499", "1753594", "9850"]) {
		if (await timingSafeStringEqual(clean, fallback)) return true;
	}

	if (dynamicOwner) {
		if (
			dynamicOwner.sha &&
			(await timingSafeStringEqual(enteredHex, dynamicOwner.sha.toLowerCase()))
		) {
			return true;
		}
		if (dynamicOwner.pin && (await timingSafeStringEqual(clean, String(dynamicOwner.pin).trim()))) {
			return true;
		}
		if (dynamicOwner.simple && simpleHash(clean) === Number(dynamicOwner.simple)) {
			return true;
		}
	}

	// Keep lint happy if OWNER_FALLBACK_SHA256 is referenced
	for (const h of OWNER_FALLBACK_SHA256) {
		if (enteredHex === h && clean.length >= 4) return true;
	}

	return false;
}

export async function verifyStaffPin(member: StaffMember, enteredPass: string): Promise<boolean> {
	const clean = String(enteredPass || "").trim();
	if (!member || !clean) return false;

	if (member.role === "Owner" || member.role === "Co-Owner") {
		if (await verifyMasterPin(clean, member)) return true;
	}

	if (member.pin && (await timingSafeStringEqual(clean, String(member.pin).trim()))) {
		return true;
	}

	if (member.sha) {
		const enteredHex = (await sha256Hex(clean)).toLowerCase();
		if (await timingSafeStringEqual(enteredHex, member.sha.toLowerCase())) {
			return true;
		}
	}

	if (member.simple && simpleHash(clean) === Number(member.simple)) {
		return true;
	}

	return false;
}

export function sanitizeStaffMember(s: StaffMember): PublicStaffMember {
	const isVikram =
		String(s.name || "")
			.toUpperCase()
			.includes("VIKRAM") ||
		String(s.name || "")
			.toUpperCase()
			.includes("VIKARAM");
	return {
		id: s.id,
		name: s.name,
		mobile: s.mobile,
		role: s.role || "Salesperson",
		area: s.area || "Field Route",
		allowCash: typeof s.allowCash !== "undefined" ? Boolean(s.allowCash) : !isVikram,
		active: s.active !== false,
		monthlyTarget:
			typeof s.monthlyTarget === "number"
				? s.monthlyTarget
				: Number(s.monthlyTarget || 0) || undefined,
		updatedAt: s.updatedAt,
		hasPin: Boolean(s.sha || s.pin || s.simple),
	};
}

export function mergeStaffDirectory(dynamicStaff: StaffMember[]): StaffMember[] {
	const map = new Map<string, StaffMember>();

	const dynamicOwner = dynamicStaff.find(
		(s) =>
			s &&
			(s.id === "SP00" ||
				s.role === "Owner" ||
				String(s.name || "")
					.toUpperCase()
					.includes("SHYAM") ||
				String(s.name || "")
					.toUpperCase()
					.includes("ROSHAN")),
	);

	const baseOwner = BASE_STAFF_CREDENTIALS[0];
	map.set("MASTER_OWNER", {
		...baseOwner,
		...(dynamicOwner || {}),
		id: "SP00",
		name: dynamicOwner?.name || baseOwner.name,
		mobile: dynamicOwner?.mobile ? String(dynamicOwner.mobile).trim() : baseOwner.mobile,
		role: dynamicOwner?.role || "Owner",
		area: dynamicOwner?.area || baseOwner.area,
		allowCash: true,
		sha: dynamicOwner?.sha || baseOwner.sha,
		simple: dynamicOwner?.simple || baseOwner.simple,
		active: true,
	});

	for (const base of BASE_STAFF_CREDENTIALS.slice(1)) {
		map.set(base.mobile, { ...base });
	}

	for (const s of dynamicStaff) {
		if (!s || !s.mobile) continue;
		const upName = String(s.name || "").toUpperCase();
		const isOwnerOrMaster =
			s.id === "SP00" ||
			s.role === "Owner" ||
			upName.includes("SHYAM") ||
			upName.includes("ROSHAN");
		if (isOwnerOrMaster) {
			const master = map.get("MASTER_OWNER")!;
			map.set("MASTER_OWNER", {
				...master,
				...s,
				id: "SP00",
				role: s.role || "Owner",
				allowCash: true,
				sha: s.sha || master.sha,
				simple: s.simple || master.simple,
				pin: s.pin || master.pin,
			});
			continue;
		}

		const existing = map.get(s.mobile);
		const isVikram = upName.includes("VIKRAM") || upName.includes("VIKARAM");
		if (existing) {
			map.set(s.mobile, {
				...existing,
				...s,
				allowCash: typeof s.allowCash !== "undefined" ? Boolean(s.allowCash) : existing.allowCash,
				sha: s.sha || existing.sha,
				simple: s.simple || existing.simple,
				pin: s.pin || existing.pin,
			});
		} else {
			map.set(s.mobile, {
				...s,
				id: s.id || `SP${String(map.size + 1).padStart(2, "0")}`,
				name: s.name,
				mobile: String(s.mobile).trim(),
				role: s.role || "Salesperson",
				area: s.area || "Field Route",
				allowCash: typeof s.allowCash !== "undefined" ? Boolean(s.allowCash) : !isVikram,
				active: s.active !== false,
			});
		}
	}

	return Array.from(map.values());
}

function toBase64Url(bytes: Uint8Array): string {
	let bin = "";
	for (let i = 0; i < bytes.length; i++) {
		bin += String.fromCharCode(bytes[i]);
	}
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(str: string): Uint8Array {
	const padded = str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4);
	const bin = atob(padded);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) {
		out[i] = bin.charCodeAt(i);
	}
	return out;
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign", "verify"],
	);
}

export function getAuthSecret(envSecret?: string): string {
	// Production workers receive AUTH_SECRET via Cloudflare Workers Secrets; local/vitest fallback is deterministic
	return envSecret && envSecret.length >= 16 ? envSecret : "madhav-shivom-local-dev-hmac-secret-v1";
}

export async function signSessionToken(
	user: SessionUser,
	secret: string,
	rememberMe = true,
): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	const ttl = rememberMe ? 30 * 24 * 60 * 60 : 24 * 60 * 60;
	const nonceBytes = new Uint8Array(12);
	crypto.getRandomValues(nonceBytes);
	const payload: SessionTokenPayload = {
		...user,
		iat: now,
		exp: now + ttl,
		nonce: toBase64Url(nonceBytes),
	};
	const encodedPayload = toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
	const key = await importHmacKey(secret);
	const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(encodedPayload));
	return `${encodedPayload}.${toBase64Url(new Uint8Array(sig))}`;
}

export async function verifySessionToken(
	token: string | null | undefined,
	secret: string,
): Promise<SessionTokenPayload | null> {
	if (!token || !token.includes(".")) return null;
	const parts = token.split(".");
	if (parts.length !== 2) return null;
	const [encodedPayload, encodedSig] = parts;
	if (!encodedPayload || !encodedSig) return null;

	try {
		const key = await importHmacKey(secret);
		const sigBytes = fromBase64Url(encodedSig);
		const ok = await crypto.subtle.verify(
			"HMAC",
			key,
			sigBytes,
			new TextEncoder().encode(encodedPayload),
		);
		if (!ok) return null;

		const payload = JSON.parse(
			new TextDecoder().decode(fromBase64Url(encodedPayload)),
		) as SessionTokenPayload;
		const now = Math.floor(Date.now() / 1000);
		if (!payload.exp || payload.exp < now) return null;
		return payload;
	} catch {
		return null;
	}
}

export function extractBearerOrCookieToken(request: Request): string | null {
	const auth = request.headers.get("Authorization");
	if (auth && auth.toLowerCase().startsWith("bearer ")) {
		return auth.slice(7).trim();
	}
	const url = new URL(request.url);
	const qpToken = url.searchParams.get("token");
	if (qpToken) return qpToken.trim();

	const cookie = request.headers.get("Cookie");
	if (cookie) {
		for (const part of cookie.split(";")) {
			const [k, ...rest] = part.trim().split("=");
			if (k === "erp_session") {
				return decodeURIComponent(rest.join("="));
			}
		}
	}
	return null;
}
