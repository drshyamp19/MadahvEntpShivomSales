// Cloudflare Workers dual-brand ERP deployment configuration (Madhav Enterprises & Shivom Sales)
import { bindings, defineConfig, defineWorker, exports } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

const erpDoHost = defineWorker({
	name: "madhav-enterprises",
	compatibilityDate: "2026-11-23",
	entrypoint,
	exports: {
		ErpLedgerDO: exports.durableObject({ storage: "sqlite" }),
	},
});

export default defineConfig(({ mode }) => {
	const isShivom = mode === "shivom";

	return {
		worker: {
			name: isShivom ? "shivom-sales" : "madhav-enterprises",
			compatibilityDate: "2026-11-23",
			compatibilityFlags: ["nodejs_compat"],
			entrypoint,
			assets: {
				htmlHandling: "auto-trailing-slash",
				notFoundHandling: "none",
				runWorkerFirst: ["/", "/index.html", "/manifest.json", "/sw.js", "/api/*"],
			},
			observability: {
				enabled: true,
				logs: { enabled: true, headSamplingRate: 1 },
				traces: { enabled: true, headSamplingRate: 0.1 },
			},
			env: {
				DEFAULT_BRAND: bindings.text(isShivom ? "SHIVOM" : "MADHAV"),
				ASSETS: bindings.assets(),
				ERP_DO: bindings.durableObject({
					worker: erpDoHost,
					exportName: "ErpLedgerDO",
				}),
				AUTH_SECRET: bindings.secret(),
			},
			...(isShivom
				? {}
				: {
						exports: {
							ErpLedgerDO: exports.durableObject({ storage: "sqlite" }),
						},
					}),
		},
	};
});
