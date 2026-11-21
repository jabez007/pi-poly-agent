import js from "@eslint/js";
import ts from "typescript-eslint";

export default ts.config(
	{ ignores: ["node_modules/**", ".poly/**"] },
	js.configs.recommended,
	...ts.configs.recommended,
	{
		files: ["**/*.ts"],
		rules: {
			complexity: ["error", 12],
			"@typescript-eslint/no-explicit-any": "off",
			"@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
		},
	},
);
