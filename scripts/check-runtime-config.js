#!/usr/bin/env node
'use strict';

const { productionConfigReport } = require('../lib/runtime-config');

const report = productionConfigReport(process.env);
for (const warning of report.warnings) process.stderr.write(`WARNING: ${warning}\n`);
if (report.errors.length) {
  for (const error of report.errors) process.stderr.write(`ERROR: ${error}\n`);
  process.exit(1);
}
process.stdout.write(`Runtime configuration accepted for ${report.production ? 'production' : 'development'}.\n`);
