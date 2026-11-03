import { assert } from "./assert.js";
import { buildTrainingWhere } from "../src/utils/queryEngine/builders/training.builder.js";
import { TrainingQuerySchema } from "../src/utils/queryEngine/schemas/training.schema.js";
import { mapTrainingToDTO } from "../src/utils/queryEngine/mappers/training.mapper.js";

const unissuedWhere = buildTrainingWhere(
  TrainingQuerySchema.parse({ certificateIssued: false }),
);
assert(
  JSON.stringify(unissuedWhere.certificate) === JSON.stringify({ is: null }),
  "Unissued training filtering uses the linked certificate relation",
);

const issuedWhere = buildTrainingWhere(
  TrainingQuerySchema.parse({ certificateIssued: true }),
);
assert(
  JSON.stringify(issuedWhere.certificate) === JSON.stringify({ isNot: null }),
  "Issued training filtering uses the linked certificate relation",
);

const staleTraining = mapTrainingToDTO({
  id: "training-with-stale-issued-flag",
  certificateIssued: true,
  certificate: null,
});
assert(
  !staleTraining.certificateIssued,
  "A stale issued flag without a linked certificate does not hide a training",
);

const issuedTraining = mapTrainingToDTO({
  id: "training-with-certificate",
  certificateIssued: false,
  certificate: { id: "certificate-id" },
});
assert(
  issuedTraining.certificateIssued,
  "A linked certificate marks the training as issued",
);

console.log("All certificate eligibility tests passed.");
