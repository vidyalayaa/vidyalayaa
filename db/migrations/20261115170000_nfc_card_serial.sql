ALTER TABLE nfc_cards
  ADD COLUMN card_serial text CHECK (card_serial ~ '^[A-Z0-9][A-Z0-9._/-]{0,63}$');

CREATE UNIQUE INDEX nfc_cards_school_serial_in_use
  ON nfc_cards (school_id, card_serial)
  WHERE card_serial IS NOT NULL AND status <> 'RETIRED';
