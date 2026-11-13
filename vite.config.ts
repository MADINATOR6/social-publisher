import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
	plugins: [react()],
	server: {
		port: 5173,
		strictPort: true,
		proxy: { '/api': 'http://127.0.0.1:8787', '/m': 'http://127.0.0.1:8787' },
	},
	test: { include: ['tests/**/*.test.ts'], environment: 'node', pool: 'forks', setupFiles: ['tests/setup.ts'], fileParallelism: false },
} as any);
