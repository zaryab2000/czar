import type { AcceptancePorts } from "#src/acceptance/types";
import type { RegisteredSelection } from "#src/selection/registered/index";

export interface AcceptancePortOptions {
  readonly selection: Pick<RegisteredSelection, "outputSchema">;
  readonly keyAddress: (keyRef: "K7") => Promise<string>;
  readonly now?: () => Date;
}

/** Creates production ports backed by the registered directory and the signer address lookup. */
export function createAcceptancePorts(options: AcceptancePortOptions): AcceptancePorts {
  return {
    outputSchema: options.selection.outputSchema,
    shapeHistory: { forService: async () => null },
    validatorIdentity: { address: () => options.keyAddress("K7") },
    clock: { now: options.now ?? (() => new Date()) },
  };
}
