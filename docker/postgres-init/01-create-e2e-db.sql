-- Runs once, only on a fresh postgres-data volume: gives the e2e test suite
-- its own database so it never reads or writes the dev database's rows.
CREATE DATABASE flash_sale_test OWNER flash_sale;
