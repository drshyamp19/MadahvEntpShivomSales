import { buildPagesASSETSBinding, cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vite-plus";

export default defineConfig({
	plugins: [
		cloudflareTest(async () => ({
			config: true,
			miniflare: {
				serviceBindings: {
					ASSETS: await buildPagesASSETSBinding("./public"),
				},
			},
		})),
	],
});
