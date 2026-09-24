import tseslint from "typescript-eslint";
import da from "@dynamicagents/core/eslint";

const LINTED_FILES = ["src/**/*.ts", "test/**/*.ts"];

export default tseslint.config(
  {
    extends: [...tseslint.configs.recommended],
    files: LINTED_FILES,
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "no-unused-expressions": "off",
      "@typescript-eslint/no-unused-expressions": [
        "error",
        { allowTaggedTemplates: true }
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_"
        }
      ],
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              // The one thing a plugin genuinely cannot share with core. The
              // migrator keeps a single flat integer journal and one global
              // `__drizzle_migrations` table, so two independently-versioned
              // packages collide in it — the two predecessor agents had already
              // forked that journal at index 1.
              name: "drizzle-orm/durable-sqlite/migrator",
              message:
                "A plugin must not run drizzle's migrator — the agent's Durable Object has one " +
                "migration journal, and it is core's."
            }
          ]
        }
      ]
    }
  },
  {
    // Type-aware pass — enables @deprecated detection without switching the
    // whole config to recommendedTypeChecked and its stricter rule set.
    files: LINTED_FILES,
    plugins: { "@typescript-eslint": tseslint.plugin, da },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      "@typescript-eslint/no-deprecated": "error",
      "da/no-deprecated-object-properties": "error"
    }
  },
  {
    ignores: [
      "dist/",
      "node_modules/",
      ".wrangler/",
      "worker-configuration.d.ts"
    ]
  }
);
