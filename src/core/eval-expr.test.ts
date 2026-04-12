import { strict as assert } from "node:assert";
import { evaluateExpr } from "./eval-expr.js";

function run(): void {
  assert.equal(evaluateExpr({ op: "const", value: 5 }, {}), 5);
  assert.equal(evaluateExpr({ op: "var", name: "x" }, { x: 12 }), 12);
  assert.equal(
    evaluateExpr(
      {
        op: "add",
        args: [
          { op: "const", value: 10 },
          {
            op: "mul",
            args: [{ op: "const", value: 2 }, { op: "var", name: "y" }],
          },
        ],
      },
      { y: 3 },
    ),
    16,
  );
  assert.equal(
    evaluateExpr(
      {
        op: "max",
        args: [{ op: "const", value: 1 }, { op: "const", value: 7 }, { op: "const", value: 4 }],
      },
      {},
    ),
    7,
  );
  assert.equal(
    evaluateExpr(
      {
        op: "min",
        args: [{ op: "const", value: 11 }, { op: "const", value: 7 }, { op: "const", value: 9 }],
      },
      {},
    ),
    7,
  );
  assert.equal(evaluateExpr({ op: "var", name: "missing" }, {}), 0);
  assert.equal(
    evaluateExpr(
      { op: "div", args: [{ op: "const", value: 9 }, { op: "const", value: 0 }] },
      {},
    ),
    0,
  );
}

run();
process.stdout.write("eval-expr tests passed\n");
