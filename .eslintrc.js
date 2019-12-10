module.exports = {
    "env": {
        "es2017": true,
        "node": true,
    },
    "globals":{
      "BigInt": true,
    },
    "parserOptions": {
        "ecmaVersion": 9, // Object spread syntax
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