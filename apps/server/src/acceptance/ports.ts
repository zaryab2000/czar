import type { AcceptancePorts } from "#src/acceptance/types";
import type { RegisteredSelection } from "#src/selection/registered/index";
import type { Address } from "viem";

export interface AcceptancePortOptions {
  readonly selection: Pick<RegisteredSelection, "outputSchema">;
  readonly keyAddress: (caller: "cz-16", keyRef: "K7") => Promise<Address>;
  readonly now?: () => Date;
}

/** Creates production ports backed by the registered directory and the signer address lookup. */
export function createAcceptancePorts(options: AcceptancePortOptions): AcceptancePorts {
  return {
    outputSchema: options.selection.outputSchema,
    shapeHistory: { forService: async () => null },
    validatorIdentity: { address: () => options.keyAddress("cz-16", "K7") },
    clock: { now: options.now ?? (() => new Date()) },
  };
}
