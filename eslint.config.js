import js from '@eslint/js';
import ts from 'typescript-eslint';
import svelte from 'eslint-plugin-svelte';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default ts.config(
	js.configs.recommended,
	...ts.configs.recommended,
	...svelte.configs.recommended,
	// Turns off ESLint rules that overlap with Prettier. Must stay after the
	// recommended configs so its disables win. Formatting is Prettier's job.
	prettier,
	...svelte.configs.prettier,
	{
		languageOptions: {
			globals: { ...globals.node, ...globals.browser },
		},
	},
	{
		files: ['**/*.svelte'],
		languageOptions: {
			parserOptions: { parser: ts.parser },
		},
	},
	{
		// `.svelte.ts` modules are plain TypeScript that happens to use Svelte 5
		// runes (`$state`, `$derived`). typescript-eslint matches only `*.ts`
		// by default; this entry ensures `.svelte.ts` files are parsed as TS too
		// (the runes themselves are valid TS — they desugar at compile time).
		files: ['**/*.svelte.ts', '**/*.svelte.js'],
		languageOptions: {
			parser: ts.parser,
		},
	},
	{
		ignores: ['build/', '.svelte-kit/', 'dist/', 'drizzle/', 'node_modules/'],
	},
);
