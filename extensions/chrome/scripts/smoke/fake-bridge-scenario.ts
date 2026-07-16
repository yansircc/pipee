import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import type { WireCommand, WireResult } from "../../src/protocol/schema.js";
import { decodeWireResult, RESULT_DELIVERY_POLICY } from "./protocol-fixture.ts";
import {
  INCOMPATIBLE_COMMAND,
  VERSION_COMMAND,
  type SuccessfulWireResult,
} from "./scenario-fixture.ts";
import { deferred, delay, SmokeFailure, type Deferred } from "./support.ts";

type WriteJson = (
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>>,
) => void;

const incompatibleFingerprint = (fingerprint: string): string =>
  `${fingerprint.startsWith("0") ? "1" : "0"}${fingerprint.slice(1)}`;

export class SmokeCommandScenario {
  readonly commandReady: Deferred<string> = deferred();
  readonly resultReady: Deferred<SuccessfulWireResult> = deferred();
  readonly allResultsReady: Deferred<ReadonlyArray<SuccessfulWireResult>> = deferred();
  readonly fingerprintMismatchReady = deferred();
  readonly pollAfterAcknowledgement = deferred();
  readonly resultAttempts = new Map<string, number>();
  readonly results: Array<SuccessfulWireResult> = [];

  commandDeliveryReleased = false;
  nextCommandIndex = 0;
  currentCommand: WireCommand | undefined;
  incompatibleResultAttempts = 0;

  private readonly releaseCommand = deferred();
  private readonly releaseResult = deferred();
  private commands: ReadonlyArray<WireCommand> = [];
  private fingerprintMismatchArmed = false;
  private fingerprintMismatchPhase = 0;
  private readonly expectedExtensionId: string;
  private readonly expectedExtensionDisplayVersion: string;
  private readonly protocolFingerprint: () => string;
  private readonly writeJson: WriteJson;

  constructor(
    expectedExtensionId: string,
    expectedExtensionDisplayVersion: string,
    protocolFingerprint: () => string,
    writeJson: WriteJson,
  ) {
    this.expectedExtensionId = expectedExtensionId;
    this.expectedExtensionDisplayVersion = expectedExtensionDisplayVersion;
    this.protocolFingerprint = protocolFingerprint;
    this.writeJson = writeJson;
  }

  setCommands(commands: ReadonlyArray<WireCommand>): void {
    assert.equal(this.commands.length, 0, "Smoke commands may only be initialized once");
    this.commands = commands;
  }

  armFingerprintMismatch(): void {
    assert.equal(this.fingerprintMismatchArmed, false);
    assert.equal(this.fingerprintMismatchPhase, 0);
    this.fingerprintMismatchArmed = true;
  }

  releaseCommandDelivery(): void {
    assert.equal(this.commandDeliveryReleased, false);
    this.commandDeliveryReleased = true;
    this.releaseCommand.resolve();
  }

  releaseResultDelivery(): void {
    this.releaseResult.resolve();
  }

  async handlePoll(
    response: ServerResponse,
    headers: Readonly<Record<string, string>>,
  ): Promise<void> {
    const protocolFingerprint = this.protocolFingerprint();
    if (!this.fingerprintMismatchArmed) {
      await delay(100);
      this.writeJson(
        response,
        200,
        {
          type: "none",
          expectedExtensionId: this.expectedExtensionId,
          expectedExtensionDisplayVersion: this.expectedExtensionDisplayVersion,
          expectedProtocolFingerprint: protocolFingerprint,
        },
        headers,
      );
      return;
    }
    const mismatchedFingerprint = incompatibleFingerprint(protocolFingerprint);
    if (this.fingerprintMismatchPhase === 0) {
      this.fingerprintMismatchPhase = 1;
      this.writeJson(
        response,
        200,
        {
          type: "incompatible",
          expectedExtensionId: this.expectedExtensionId,
          expectedExtensionDisplayVersion: this.expectedExtensionDisplayVersion,
          actualExtensionDisplayVersion: this.expectedExtensionDisplayVersion,
          expectedProtocolFingerprint: mismatchedFingerprint,
          actualProtocolFingerprint: protocolFingerprint,
        },
        headers,
      );
      return;
    }
    if (this.fingerprintMismatchPhase === 1) {
      this.fingerprintMismatchPhase = 2;
      this.writeJson(
        response,
        200,
        {
          type: "command",
          command: INCOMPATIBLE_COMMAND,
          expectedExtensionId: this.expectedExtensionId,
          expectedExtensionDisplayVersion: this.expectedExtensionDisplayVersion,
          expectedProtocolFingerprint: mismatchedFingerprint,
        },
        headers,
      );
      return;
    }
    if (this.fingerprintMismatchPhase === 2) {
      this.fingerprintMismatchPhase = 3;
      this.fingerprintMismatchReady.resolve();
    }
    if (this.currentCommand) {
      throw new SmokeFailure("Connector polled before its command result was acknowledged");
    }
    if (this.results.length === 1) this.pollAfterAcknowledgement.resolve();
    const nextCommand = this.commands[this.nextCommandIndex];
    if (nextCommand) {
      if (this.nextCommandIndex === 0) await this.releaseCommand.promise;
      this.currentCommand = nextCommand;
      this.nextCommandIndex += 1;
      if (this.nextCommandIndex === 1) this.commandReady.resolve(nextCommand.id);
      this.writeJson(
        response,
        200,
        {
          type: "command",
          command: nextCommand,
          expectedExtensionId: this.expectedExtensionId,
          expectedExtensionDisplayVersion: this.expectedExtensionDisplayVersion,
          expectedProtocolFingerprint: protocolFingerprint,
        },
        headers,
      );
      return;
    }
    await delay(500);
    this.writeJson(
      response,
      200,
      {
        type: "none",
        expectedExtensionId: this.expectedExtensionId,
        expectedExtensionDisplayVersion: this.expectedExtensionDisplayVersion,
        expectedProtocolFingerprint: protocolFingerprint,
      },
      headers,
    );
  }

  async handleResult(
    response: ServerResponse,
    body: string,
    headers: Readonly<Record<string, string>>,
  ): Promise<void> {
    const result: WireResult = decodeWireResult(body);
    if (result.id === INCOMPATIBLE_COMMAND.id) {
      this.incompatibleResultAttempts += 1;
      throw new SmokeFailure("Connector executed a command with a mismatched fingerprint");
    }
    if (!this.currentCommand || result.id !== this.currentCommand.id) {
      this.writeJson(
        response,
        RESULT_DELIVERY_POLICY.unknownCommandStatus,
        { ok: false, error: "unknown command id" },
        headers,
      );
      return;
    }
    if (result.id === VERSION_COMMAND.id) await this.releaseResult.promise;
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    const attempts = (this.resultAttempts.get(result.id) ?? 0) + 1;
    this.resultAttempts.set(result.id, attempts);
    if (result.id === VERSION_COMMAND.id && attempts === 1) {
      this.writeJson(
        response,
        401,
        { ok: false, error: "forced authentication rejection" },
        headers,
      );
      return;
    }
    const completed = Object.freeze(result);
    this.results.push(completed);
    this.currentCommand = undefined;
    if (result.id === VERSION_COMMAND.id) this.resultReady.resolve(completed);
    if (this.results.length === this.commands.length) this.allResultsReady.resolve(this.results);
    this.writeJson(response, RESULT_DELIVERY_POLICY.acknowledgedStatus, { ok: true }, headers);
  }

  releaseWaiters(): void {
    this.releaseCommand.resolve();
    this.releaseResult.resolve();
  }
}
