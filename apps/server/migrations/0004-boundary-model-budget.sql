ALTER TABLE model_usage DROP CONSTRAINT model_usage_prompt_check;
ALTER TABLE model_usage ADD CONSTRAINT model_usage_prompt_check
  CHECK (prompt IN ('P-01','P-02','P-04','P-05','P-06','P-07'));

ALTER TABLE model_reservations DROP CONSTRAINT model_reservations_prompt_check;
ALTER TABLE model_reservations ADD CONSTRAINT model_reservations_prompt_check
  CHECK (prompt IN ('P-01','P-02','P-04','P-05','P-06','P-07'));
