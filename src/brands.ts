import type { CompanyKey } from "./types.ts";

export interface BrandMetadata {
	key: CompanyKey;
	workerName: string;
	origin: string;
	title: string;
	shortName: string;
	description: string;
	addressLine: string;
	phone: string;
	gstin: string;
	themeColor: string;
	backgroundColor: string;
	logoPath: string;
	ogImagePath: string;
	icon192Path: string;
	icon512Path: string;
	qrPath: string;
}

export const BRANDS: Record<CompanyKey, BrandMetadata> = {
	MADHAV: {
		key: "MADHAV",
		workerName: "madhav-enterprises",
		origin: "https://madhav-enterprises.madhavshivom.workers.dev",
		title: "MADHAV ENTERPRISES - Cloud ERP Portal",
		shortName: "Madhav ERP",
		description:
			"MADHAV ENTERPRISES (Indora, Nagpur) — Greenchef Cookware & Appliances Stock, Orders, GST Invoices, Dealer Statements & Payment Recovery Portal",
		addressLine: "Plot No 408, Besan Bag, Indora, Nagpur - 440014",
		phone: "7499477581",
		gstin: "27BQIPP3836Q1ZZ",
		themeColor: "#1e3a5f",
		backgroundColor: "#0f172a",
		logoPath: "/madhav-logo.png",
		ogImagePath: "/madhav-logo.png",
		icon192Path: "/icons/icon-192.png",
		icon512Path: "/icons/icon-512.png",
		qrPath: "/madhav-qr-code.jpeg",
	},
	SHIVOM: {
		key: "SHIVOM",
		workerName: "shivom-sales",
		origin: "https://shivom-sales.madhavshivom.workers.dev",
		title: "SHIVOM SALES & SERVICES - Cloud ERP Portal",
		shortName: "Shivom ERP",
		description:
			"SHIVOM SALES & SERVICES (Indora, Nagpur) — Electrical, Fans, Gas Pipes, Mixers & Appliances Stock, Orders, Bills & Payment Recovery Portal",
		addressLine: "10 No Puliya, Near Samadhan Decoration, Indora Bazonbagh, Nagpur - 440014",
		phone: "7499477581",
		gstin: "",
		themeColor: "#0f766e",
		backgroundColor: "#042f2e",
		logoPath: "/shivom-logo-cropped.png",
		ogImagePath: "/shivom-logo-cropped.png",
		icon192Path: "/shivom-logo-cropped.png",
		icon512Path: "/shivom-logo-cropped.png",
		qrPath: "/shivom-qr-code.jpeg",
	},
};

export function normalizeCompanyKey(
	raw: string | null | undefined,
	fallback: CompanyKey = "MADHAV",
): CompanyKey {
	const up = String(raw || "")
		.trim()
		.toUpperCase();
	if (up === "SHIVOM") return "SHIVOM";
	if (up === "MADHAV") return "MADHAV";
	return fallback;
}

export function resolveBrandForRequest(request: Request, defaultBrandRaw?: string): BrandMetadata {
	const url = new URL(request.url);
	const defaultKey = normalizeCompanyKey(defaultBrandRaw, "MADHAV");

	const queryCo = url.searchParams.get("co") || url.searchParams.get("brand");
	if (queryCo) {
		return BRANDS[normalizeCompanyKey(queryCo, defaultKey)];
	}

	const host = url.hostname.toLowerCase();
	if (host.includes("shivom")) {
		return BRANDS.SHIVOM;
	}
	if (host.includes("madhav-enterprises")) {
		return BRANDS.MADHAV;
	}

	return BRANDS[defaultKey];
}

export function buildManifestJson(brand: BrandMetadata): Record<string, unknown> {
	return {
		name: `${brand.title}`,
		short_name: brand.shortName,
		description: brand.description,
		start_url: "/",
		scope: "/",
		display: "standalone",
		orientation: "portrait-primary",
		background_color: brand.backgroundColor,
		theme_color: brand.themeColor,
		icons: [
			{
				src: brand.icon192Path,
				sizes: "192x192",
				type: "image/png",
				purpose: "any maskable",
			},
			{
				src: brand.icon512Path,
				sizes: "512x512",
				type: "image/png",
				purpose: "any maskable",
			},
		],
	};
}
