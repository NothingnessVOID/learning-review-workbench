import { writeFileSync } from "node:fs";
import { z } from "zod";
import { schemas } from "../src/domain/schema.js";
import { sharedToolSchemas } from "../src/domain/contracts.js";
for (const [name, schema] of Object.entries(schemas))
  writeFileSync(
    `schemas/${name}.json`,
    JSON.stringify(z.toJSONSchema(schema, { io: "input" }), null, 2) + "\n",
  );
const contracts = Object.fromEntries(
  Object.entries(sharedToolSchemas).map(([name, schema]) => [
    name,
    z.toJSONSchema(schema, { io: "input" }),
  ]),
);
writeFileSync(
  "docs/TOOL_CONTRACTS.json",
  JSON.stringify(
    { schema_representation: "input", tools: contracts },
    null,
    2,
  ) + "\n",
);
console.log(
  `Exported ${Object.keys(schemas).length} object schemas and ${Object.keys(contracts).length} tool input contracts.`,
);
