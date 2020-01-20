module.exports = {
    "env": {
        "es2020": true,
        "node": true,
    },
    "parserOptions": {
        "ecmaVersion": 2020,
    },
    "extends": ["eslint:recommended", "google"],
    "rules": {
        "max-len": ["error", { "code": 120, "ignoreComments": true, "ignoreTrailingComments": true }],
        "no-trailing-spaces": ["error", { "skipBlankLines": true, "ignoreComments": true }],
        "no-multiple-empty-lines": "off",
        "one-var": "off",
        "no-constant-condition": ["error", { "checkLoops": false }],
        "new-cap": "off",
    },

};