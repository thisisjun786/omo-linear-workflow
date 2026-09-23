#!/usr/bin/env bun

const { HERDR_FIXTURE_OUTPUT: outputPath, HOSTILE_VALUE: value } = process.env;
if (outputPath === undefined) throw new Error("HERDR_FIXTURE_OUTPUT is required");
await Bun.write(outputPath, JSON.stringify({ argv: process.argv.slice(2), value: value ?? null }));

export {};
