import { env } from "cloudflare:workers";
import {
	extractBearerOrCookieToken,
	getAuthSecret,
	signSessionToken,
	verifySessionToken,
} from "./auth.ts";
import {
	BRANDS,
	buildManifestJson,
	normalizeCompanyKey,
	resolveBrandForRequest,
} from "./brands.ts";
import { ErpLedgerDO } from "./erp-do.ts";
import {
	COLLECTION_NAMES,
	type CollectionName,
	type CompanyKey,
	type CompanySettings,
	type ErpRecord,
	type SessionTokenPayload,
} from "./types.ts";

export { ErpLedgerDO };

const ADMIN_DELETE_COLLECTIONS = new Set<CollectionName>([
	"salespersons",
	"orders",
	"collections",
	"purchaseBills",
	"salesReturns",
	"expenses",
	"cashHandovers",
	"bankDeposits",
	"products",
	"parties",
]);

function isValidCollection(col: string): col is CollectionName {
	return (COLLECTION_NAMES as readonly string[]).includes(col);
}

function getLedgerStub(company: CompanyKey): DurableObjectStub<ErpLedgerDO> {
	return env.ERP_DO.getByName(company);
}

function jsonNoStore(data: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
	return Response.json(data, {
		status,
		headers: {
			"Cache-Control": "no-store, no-cache, must-revalidate",
			...(extraHeaders || {}),
		},
	});
}

function escapeHtmlAttr(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function buildServiceWorkerJs(brandKey: CompanyKey): string {
	const cacheName = `madhav-shivom-cf-erp-${brandKey.toLowerCase()}-v5-vendor-local`;
	return `const CACHE_NAME = '${cacheName}';
const APP_SHELL = [
  '/',
  '/manifest.json',
  '/madhav-logo.png',
  '/madhav-qr-code.jpeg',
  '/shivom-logo.jpg',
  '/shivom-logo-cropped.png',
  '/shivom-qr-code.jpeg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
  '/vendor/xlsx.full.min.js',
  '/vendor/qrcode.min.js',
  '/vendor/html2pdf.bundle.min.js'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).catch(() => {})
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Never cache dynamic API, WebSocket, live media, or large APK setup downloads
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/downloads/') ||
    url.pathname.endsWith('.apk')
  ) {
    return;
  }

  const isSameOrigin = url.origin === self.location.origin;
  const isAllowedCdn =
    url.hostname === 'cdn.sheetjs.com' ||
    url.hostname === 'cdn.jsdelivr.net' ||
    url.hostname === 'cdnjs.cloudflare.com' ||
    url.hostname === 'fonts.googleapis.com' ||
    url.hostname === 'fonts.gstatic.com';

  if (!isSameOrigin && !isAllowedCdn) return;

  if (isAllowedCdn) {
    event.respondWith(
      caches.match(req).then((cached) => {
        const fetchPromise = fetch(req)
          .then((res) => {
            if (res && res.status === 200) {
              const clone = res.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(req, clone)).catch(() => {});
            }
            return res;
          })
          .catch(() => cached);
        return cached || fetchPromise;
      })
    );
    return;
  }

  // Network-first for Cloudflare origin so updates load immediately
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.status === 200) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req).then((cached) => cached || caches.match('/')))
  );
});
`;
}

async function requireSession(request: Request): Promise<SessionTokenPayload | null> {
	const token = extractBearerOrCookieToken(request);
	return verifySessionToken(token, getAuthSecret(env.AUTH_SECRET));
}

export default {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const pathname = url.pathname;
		const defaultBrandKey = normalizeCompanyKey(env.DEFAULT_BRAND, "MADHAV");
		const brand = resolveBrandForRequest(request, defaultBrandKey);

		try {
			// 1. Dynamic Brand PWA Manifest
			if (pathname === "/manifest.json") {
				return new Response(JSON.stringify(buildManifestJson(brand), null, 2), {
					headers: {
						"Content-Type": "application/manifest+json; charset=utf-8",
						"Cache-Control": "no-cache, must-revalidate",
					},
				});
			}

			// 2. Dynamic Brand Service Worker
			if (pathname === "/sw.js") {
				return new Response(buildServiceWorkerJs(brand.key), {
					headers: {
						"Content-Type": "application/javascript; charset=utf-8",
						"Cache-Control": "no-cache, no-store, must-revalidate",
					},
				});
			}

			// 2.5 Android APK Setup File Download (shareable via WhatsApp & Install App button)
			if (
				(pathname === "/MadhavShivomERP.apk" || pathname === "/downloads/MadhavShivomERP.apk") &&
				(request.method === "GET" || request.method === "HEAD")
			) {
				const apkReq = new Request(
					new URL("/downloads/MadhavShivomERP.apk", url.origin).toString(),
					{
						method: request.method,
						headers: request.headers,
					},
				);
				const apkRes = await env.ASSETS.fetch(apkReq);
				if (apkRes.ok) {
					const headers = new Headers(apkRes.headers);
					headers.set("Content-Type", "application/vnd.android.package-archive");
					headers.set("Content-Disposition", 'attachment; filename="MadhavShivomERP.apk"');
					headers.set("Cache-Control", "public, max-age=300");
					return new Response(request.method === "HEAD" ? null : apkRes.body, {
						status: 200,
						headers,
					});
				}
				return Response.redirect(
					"https://github.com/drshyamp19/MadahvEntpShivomSales/releases/download/latest-apk/MadhavShivomERP.apk",
					302,
				);
			}

			// 3. Health check
			if (pathname === "/api/health") {
				return jsonNoStore({ ok: true, brand: brand.key, runtime: "cloudflare-workers" });
			}

			// 4. Authentication APIs
			if (pathname === "/api/auth/login" && request.method === "POST") {
				const body = (await request.json().catch(() => ({}))) as {
					identifier?: string;
					password?: string;
					mode?: "unified" | "owner" | "staff";
					rememberMe?: boolean;
				};
				const mode = body.mode || "unified";
				const authCo = normalizeCompanyKey(url.searchParams.get("co"), defaultBrandKey);
				const stub = getLedgerStub(authCo);
				let res = await stub.authenticateUser(
					authCo,
					body.identifier || "",
					body.password || "",
					mode,
				);

				// If not found in active brand's DO staff list, also check the other brand's DO (shared enterprise login)
				if (!res.ok) {
					const altCo: CompanyKey = authCo === "MADHAV" ? "SHIVOM" : "MADHAV";
					const altRes = await getLedgerStub(altCo).authenticateUser(
						altCo,
						body.identifier || "",
						body.password || "",
						mode,
					);
					if (altRes.ok) res = altRes;
				}

				if (!res.ok) {
					return jsonNoStore({ ok: false, error: res.error }, 401);
				}

				const rememberMe = body.rememberMe !== false;
				const token = await signSessionToken(res.user, getAuthSecret(env.AUTH_SECRET), rememberMe);
				const maxAge = rememberMe ? 30 * 24 * 60 * 60 : 24 * 60 * 60;
				const isHttps = url.protocol === "https:";
				const cookie = `erp_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isHttps ? "; Secure" : ""}`;

				return jsonNoStore(
					{
						ok: true,
						token,
						user: res.user,
						defaultCompany: defaultBrandKey,
					},
					200,
					{ "Set-Cookie": cookie },
				);
			}

			if (pathname === "/api/auth/logout" && request.method === "POST") {
				return jsonNoStore({ ok: true }, 200, {
					"Set-Cookie": "erp_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
				});
			}

			if (pathname === "/api/auth/me" && request.method === "GET") {
				const session = await requireSession(request);
				if (!session) return jsonNoStore({ ok: false, error: "Unauthorized" }, 401);
				return jsonNoStore({ ok: true, user: session });
			}

			// 5. Public Document Viewer API (?view=...) — no auth required, returns only requested document
			if (pathname === "/api/public/view" && request.method === "GET") {
				const co = normalizeCompanyKey(url.searchParams.get("co"), brand.key);
				const viewType = url.searchParams.get("view") || "";
				if (!viewType) return jsonNoStore({ ok: false, error: "Missing view parameter" }, 400);
				const id = url.searchParams.get("id");
				const partyId = url.searchParams.get("partyId");
				const date = url.searchParams.get("date");

				const result = await getLedgerStub(co).getPublicDocument(co, viewType, id, partyId, date);
				return jsonNoStore({ ok: result.found, ...result }, result.found ? 200 : 404);
			}

			// 6. Media (Cheque / Payment Proof photos stored inside Durable Object SQLite)
			if (pathname.startsWith("/api/media/") && request.method === "GET") {
				const session = await requireSession(request);
				if (!session) return jsonNoStore({ ok: false, error: "Unauthorized" }, 401);
				const mediaId = decodeURIComponent(pathname.slice("/api/media/".length));
				const co = normalizeCompanyKey(url.searchParams.get("co"), defaultBrandKey);
				const media = await getLedgerStub(co).getMedia(co, mediaId);
				if (!media) {
					return new Response("Not Found", { status: 404 });
				}
				return new Response(media.data, {
					status: 200,
					headers: {
						"Content-Type": media.mimeType,
						"Cache-Control": "public, max-age=31536000, immutable",
					},
				});
			}

			if (pathname === "/api/media" && request.method === "POST") {
				const session = await requireSession(request);
				if (!session) return jsonNoStore({ ok: false, error: "Unauthorized" }, 401);

				const co = normalizeCompanyKey(url.searchParams.get("co"), defaultBrandKey);
				const body = (await request.json().catch(() => null)) as {
					id?: string;
					dataUrl?: string;
					mimeType?: string;
				} | null;

				if (!body || !body.dataUrl) {
					return jsonNoStore({ ok: false, error: "Missing image dataUrl" }, 400);
				}

				const match = body.dataUrl.match(/^data:([^;]+);base64,(.+)$/);
				if (!match) {
					return jsonNoStore({ ok: false, error: "Invalid data URL format" }, 400);
				}
				const mimeType = body.mimeType || match[1] || "image/jpeg";
				const binStr = atob(match[2]);
				const bytes = new Uint8Array(binStr.length);
				for (let i = 0; i < binStr.length; i++) {
					bytes[i] = binStr.charCodeAt(i);
				}

				const mediaId = (
					body.id || `proof_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`
				).replace(/[^a-zA-Z0-9_.-]/g, "_");
				const saved = await getLedgerStub(co).saveMedia(co, mediaId, mimeType, bytes);
				return jsonNoStore({
					ok: true,
					id: saved.id,
					size: saved.size,
					url: `/api/media/${encodeURIComponent(saved.id)}?co=${co}`,
				});
			}

			// 7. WebSocket Real-Time Live Sync (Hibernation API inside Durable Object)
			if (pathname === "/api/ws") {
				const session = await requireSession(request);
				if (!session) return new Response("Unauthorized", { status: 401 });
				if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
					return new Response("Expected Upgrade: websocket", { status: 426 });
				}
				const co = normalizeCompanyKey(url.searchParams.get("co"), defaultBrandKey);
				const doUrl = new URL(request.url);
				doUrl.searchParams.set("co", co);
				doUrl.searchParams.set("uid", session.id);
				doUrl.searchParams.set("role", session.role);
				doUrl.searchParams.set("name", session.name);
				return getLedgerStub(co).fetch(new Request(doUrl.toString(), request));
			}

			// 8. Authenticated State & CRUD APIs
			if (pathname === "/api/state" && request.method === "GET") {
				const session = await requireSession(request);
				if (!session) return jsonNoStore({ ok: false, error: "Unauthorized" }, 401);
				const co = normalizeCompanyKey(url.searchParams.get("co"), defaultBrandKey);
				const snapshot = await getLedgerStub(co).getSnapshot(co);
				return jsonNoStore({ ok: true, ...snapshot });
			}

			if (pathname.startsWith("/api/records/") && request.method === "POST") {
				const session = await requireSession(request);
				if (!session) return jsonNoStore({ ok: false, error: "Unauthorized" }, 401);

				const col = pathname.slice("/api/records/".length);
				if (!isValidCollection(col))
					return jsonNoStore({ ok: false, error: "Invalid collection" }, 400);

				if (col === "salespersons" && !session.isAdmin) {
					return jsonNoStore({ ok: false, error: "Admin permission required" }, 403);
				}
				if (col === "purchaseBills" && !session.isAdmin && session.role !== "Accountant") {
					return jsonNoStore({ ok: false, error: "Admin or Accountant permission required" }, 403);
				}

				if (col === "expenses" && !session.isAdmin) {
					const isAllowedStaff =
						session.role === "Salesperson" ||
						session.role === "Manager" ||
						session.role === "Accountant" ||
						session.role === "Co-Owner";
					if (!isAllowedStaff) {
						return jsonNoStore({ ok: false, error: "Staff permission required to record expenses" }, 403);
					}
				}

				const co = normalizeCompanyKey(url.searchParams.get("co"), defaultBrandKey);
				const item = (await request.json().catch(() => null)) as ErpRecord | null;
				if (!item || !item.id)
					return jsonNoStore({ ok: false, error: "Record id is required" }, 400);

				if (
					col === "collections" ||
					col === "bankDeposits" ||
					col === "cashHandovers" ||
					col === "expenses"
				) {
					const amt = Number(item.amount);
					if (!Number.isFinite(amt) || amt <= 0) {
						return jsonNoStore(
							{ ok: false, error: "Amount must be a positive number greater than 0" },
							400,
						);
					}
				}
				if (col === "orders" || col === "purchaseBills" || col === "salesReturns") {
					const totalVal = item.total !== undefined ? Number(item.total) : item.amount !== undefined ? Number(item.amount) : 0;
					if (!Number.isFinite(totalVal) || totalVal < 0) {
						return jsonNoStore(
							{ ok: false, error: "Total amount must be a valid non-negative number" },
							400,
						);
					}
				}

				if (
					col === "collections" &&
					item.mode === "Cash" &&
					!session.allowCash &&
					!session.isAdmin
				) {
					return jsonNoStore(
						{ ok: false, error: "Cash collection restricted for this staff account" },
						403,
					);
				}

				if (col === "chatMessages") {
					item.senderId = session.id;
					item.senderName = session.name;
					item.senderRole = session.role;
					if (!item.timestamp) item.timestamp = Date.now();
					if (!item.createdAt) item.createdAt = new Date().toISOString();
				}

				if (col === "expenses") {
					if (!session.isAdmin) {
						if (!item.staff) item.staff = session.name;
						if (!item.status) item.status = "Pending";
						item.submittedBy = session.name;
						item.submittedRole = session.role;
					}
					if (!item.createdAt) item.createdAt = new Date().toISOString();
				}

				const result = await getLedgerStub(co).upsertRecord(
					co,
					col,
					item,
					session.name,
					session.isAdmin,
					session.role,
				);
				if (col === "chatMessages" && item.channel === "ALL") {
					const otherCo: CompanyKey = co === "MADHAV" ? "SHIVOM" : "MADHAV";
					await getLedgerStub(otherCo)
						.upsertRecord(otherCo, col, item, session.name, session.isAdmin, session.role)
						.catch((err: unknown) => {
							console.error(
								JSON.stringify({
									message: "chat_cross_sync_failed",
									action: "upsert",
									otherCo,
									id: item.id,
									error: err instanceof Error ? err.message : String(err),
								}),
							);
						});
				}
				return jsonNoStore({ ok: true, ...result });
			}

			if (pathname.startsWith("/api/records/") && request.method === "DELETE") {
				const session = await requireSession(request);
				if (!session) return jsonNoStore({ ok: false, error: "Unauthorized" }, 401);

				const rest = pathname.slice("/api/records/".length);
				const slashIdx = rest.indexOf("/");
				if (slashIdx <= 0) return jsonNoStore({ ok: false, error: "Missing record id" }, 400);

				const col = rest.slice(0, slashIdx);
				const id = decodeURIComponent(rest.slice(slashIdx + 1));
				if (!isValidCollection(col) || !id)
					return jsonNoStore({ ok: false, error: "Invalid collection or id" }, 400);

				const canAccountantDelete =
					session.role === "Accountant" &&
					(col === "expenses" || col === "bankDeposits" || col === "purchaseBills");
				if (ADMIN_DELETE_COLLECTIONS.has(col) && !session.isAdmin && !canAccountantDelete) {
					return jsonNoStore(
						{ ok: false, error: "Admin permission required to delete records" },
						403,
					);
				}

				const co = normalizeCompanyKey(url.searchParams.get("co"), defaultBrandKey);
				const result = await getLedgerStub(co).deleteRecord(co, col, id, session.name);
				if (col === "chatMessages") {
					const otherCo: CompanyKey = co === "MADHAV" ? "SHIVOM" : "MADHAV";
					await getLedgerStub(otherCo)
						.deleteRecord(otherCo, col, id, session.name)
						.catch((err: unknown) => {
							console.error(
								JSON.stringify({
									message: "chat_cross_sync_failed",
									action: "delete",
									otherCo,
									id,
									error: err instanceof Error ? err.message : String(err),
								}),
							);
						});
				}
				return jsonNoStore({ ok: true, ...result });
			}

			if (pathname === "/api/settings" && request.method === "POST") {
				const session = await requireSession(request);
				if (!session) return jsonNoStore({ ok: false, error: "Unauthorized" }, 401);
				if (!session.isAdmin)
					return jsonNoStore({ ok: false, error: "Admin permission required" }, 403);

				const co = normalizeCompanyKey(url.searchParams.get("co"), defaultBrandKey);
				const patch = (await request.json().catch(() => ({}))) as CompanySettings;
				const result = await getLedgerStub(co).updateSettings(co, patch, session.name);
				return jsonNoStore({ ok: true, ...result });
			}

			if (pathname === "/api/import" && request.method === "POST") {
				const session = await requireSession(request);
				if (!session) return jsonNoStore({ ok: false, error: "Unauthorized" }, 401);
				if (!session.isAdmin)
					return jsonNoStore({ ok: false, error: "Admin permission required" }, 403);

				const co = normalizeCompanyKey(url.searchParams.get("co"), defaultBrandKey);
				const body = (await request.json().catch(() => null)) as {
					mode?: "merge" | "replace";
					collections?: Partial<Record<CollectionName, ErpRecord[]>>;
				} | null;
				if (!body || !body.collections)
					return jsonNoStore({ ok: false, error: "Missing collections" }, 400);

				const result = await getLedgerStub(co).bulkImport(
					co,
					body.collections,
					body.mode === "replace" ? "replace" : "merge",
					session.name,
				);
				return jsonNoStore({ ok: true, ...result });
			}

			if (pathname === "/api/restore" && request.method === "POST") {
				const session = await requireSession(request);
				if (!session) return jsonNoStore({ ok: false, error: "Unauthorized" }, 401);
				if (!session.isAdmin)
					return jsonNoStore({ ok: false, error: "Admin permission required" }, 403);

				const co = normalizeCompanyKey(url.searchParams.get("co"), defaultBrandKey);
				const body = (await request.json().catch(() => null)) as {
					collections?: Partial<Record<CollectionName, ErpRecord[]>>;
				} | null;
				if (!body || !body.collections)
					return jsonNoStore({ ok: false, error: "Missing backup collections" }, 400);

				const result = await getLedgerStub(co).bulkImport(
					co,
					body.collections,
					"replace",
					session.name,
				);
				return jsonNoStore({ ok: true, ...result });
			}

			if (pathname === "/api/clear" && request.method === "POST") {
				const session = await requireSession(request);
				if (!session) return jsonNoStore({ ok: false, error: "Unauthorized" }, 401);
				if (!session.isAdmin)
					return jsonNoStore({ ok: false, error: "Admin permission required" }, 403);

				const co = normalizeCompanyKey(url.searchParams.get("co"), defaultBrandKey);
				const body = (await request.json().catch(() => ({}))) as {
					scope?: "transactions" | "all";
					resetPartyOpening?: boolean;
				};
				const scope = body.scope === "all" ? "all" : "transactions";
				const result = await getLedgerStub(co).clearData(
					co,
					scope,
					Boolean(body.resetPartyOpening),
					session.name,
				);
				return jsonNoStore({ ok: true, ...result });
			}

			// 9. Serve Dynamic Brand-Aware HTML App Shell on "/" or "/index.html"
			if (pathname === "/" || pathname === "/index.html") {
				const assetReq = new Request(new URL("/app.html", url.origin).toString(), {
					method: "GET",
					headers: request.headers,
				});
				const assetRes = await env.ASSETS.fetch(assetReq);
				if (!assetRes.ok) {
					return new Response("ERP app.html asset missing", { status: 500 });
				}

				const html = await assetRes.text();
				const origin = url.origin;
				const ogImage = `${origin}${brand.ogImagePath}`;
				const brandConfig = {
					defaultBrand: defaultBrandKey,
					activeBrand: brand.key,
					brands: {
						MADHAV: {
							origin: BRANDS.MADHAV.origin,
							title: BRANDS.MADHAV.title,
							shortName: BRANDS.MADHAV.shortName,
							logoPath: BRANDS.MADHAV.logoPath,
							qrPath: BRANDS.MADHAV.qrPath,
						},
						SHIVOM: {
							origin: BRANDS.SHIVOM.origin,
							title: BRANDS.SHIVOM.title,
							shortName: BRANDS.SHIVOM.shortName,
							logoPath: BRANDS.SHIVOM.logoPath,
							qrPath: BRANDS.SHIVOM.qrPath,
						},
					},
				};

				const headMeta = `
  <title>${escapeHtmlAttr(brand.title)}</title>
  <meta name="theme-color" content="${escapeHtmlAttr(brand.themeColor)}" />
  <meta name="apple-mobile-web-app-title" content="${escapeHtmlAttr(brand.shortName)}" />
  <meta name="description" content="${escapeHtmlAttr(brand.description)}" />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="${escapeHtmlAttr(brand.shortName)}" />
  <meta property="og:title" content="${escapeHtmlAttr(brand.title)}" />
  <meta property="og:description" content="${escapeHtmlAttr(brand.description)}" />
  <meta property="og:image" content="${escapeHtmlAttr(ogImage)}" />
  <meta property="og:url" content="${escapeHtmlAttr(url.toString())}" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${escapeHtmlAttr(brand.title)}" />
  <meta name="twitter:description" content="${escapeHtmlAttr(brand.description)}" />
  <meta name="twitter:image" content="${escapeHtmlAttr(ogImage)}" />
  <link rel="icon" type="image/png" sizes="192x192" href="${escapeHtmlAttr(brand.icon192Path)}" />
  <link rel="apple-touch-icon" sizes="180x180" href="${escapeHtmlAttr(brand.key === "SHIVOM" ? brand.icon192Path : "/icons/apple-touch-icon.png")}" />
  <script>window.__ERP_BRAND_CONFIG__ = ${JSON.stringify(brandConfig)};</script>`;

				const injected = html.replace("<!-- __DYNAMIC_BRAND_META__ -->", headMeta);
				return new Response(injected, {
					status: 200,
					headers: {
						"Content-Type": "text/html; charset=utf-8",
						"Cache-Control": "no-cache, no-store, must-revalidate",
						"Pragma": "no-cache",
						"Expires": "0",
					},
				});
			}

			// 10. Fall back to Static Assets for icons, logos, QR codes, etc.
			return env.ASSETS.fetch(request);
		} catch (err) {
			const message = err instanceof Error ? err.message : "Unknown error";
			console.error(JSON.stringify({ message: "worker_error", path: pathname, error: message }));
			return jsonNoStore({ ok: false, error: message }, 500);
		}
	},
} satisfies ExportedHandler<Env>;
