export type CompanyKey = "MADHAV" | "SHIVOM";

export const COLLECTION_NAMES = [
	"products",
	"parties",
	"salespersons",
	"orders",
	"collections",
	"cashHandovers",
	"bankDeposits",
	"purchaseBills",
	"salesReturns",
	"expenses",
] as const;

export type CollectionName = (typeof COLLECTION_NAMES)[number];

export type StaffRole = "Owner" | "Co-Owner" | "Manager" | "Salesperson";

export type ErpLeafValue = string | number | boolean | null | undefined;
export type ErpSubObject = { [key: string]: ErpLeafValue };
export type ErpFieldValue = ErpLeafValue | ErpLeafValue[] | ErpSubObject | ErpSubObject[];

export interface ErpRecord {
	id: string;
	[key: string]: ErpFieldValue;
}

export interface StaffMember extends ErpRecord {
	id: string;
	name: string;
	mobile: string;
	role: StaffRole | string;
	area?: string;
	allowCash?: boolean;
	sha?: string;
	simple?: number;
	pin?: string;
	active?: boolean;
	monthlyTarget?: number;
	updatedAt?: string;
}

export interface PublicStaffMember {
	id: string;
	name: string;
	mobile: string;
	role: StaffRole | string;
	area?: string;
	allowCash?: boolean;
	active?: boolean;
	monthlyTarget?: number;
	updatedAt?: string;
	hasPin?: boolean;
}

export interface SessionUser {
	id: string;
	name: string;
	role: string;
	mobile: string;
	area: string;
	allowCash: boolean;
	isAdmin: boolean;
}

export interface SessionTokenPayload extends SessionUser {
	iat: number;
	exp: number;
	nonce: string;
}

export interface CompanySettings {
	upiId?: string;
	[key: string]: ErpFieldValue;
}

export interface SystemMeta {
	resetAt?: number;
	scope?: string;
	clearedCollections?: string[];
	resetPartyOpening?: boolean;
	clearedBy?: string;
}

export interface ErpSeedData {
	parties: ErpRecord[];
	products: ErpRecord[];
	orders: ErpRecord[];
	collections: ErpRecord[];
	salespersons: StaffMember[];
}

export interface ErpStateSnapshot {
	company: CompanyKey;
	rev: number;
	products: ErpRecord[];
	parties: ErpRecord[];
	salespersons: PublicStaffMember[];
	orders: ErpRecord[];
	collections: ErpRecord[];
	cashHandovers: ErpRecord[];
	bankDeposits: ErpRecord[];
	purchaseBills: ErpRecord[];
	salesReturns: ErpRecord[];
	expenses: ErpRecord[];
	settings: CompanySettings;
	system: SystemMeta;
}

export interface SyncEventMessage {
	type: "upsert" | "delete" | "reload" | "settings" | "clear" | "connected";
	company: CompanyKey;
	collection?: CollectionName;
	id?: string;
	item?: ErpRecord;
	settings?: CompanySettings;
	scope?: string;
	resetPartyOpening?: boolean;
	resetAt?: number;
	rev: number;
	actor?: string;
	ts: number;
}
