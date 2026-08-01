<?php

defined('ABSPATH') || exit;

const ZEROY_SITE_DRAFT_CONTRACT = 'zeroy/site-draft@1';

function zeroy_runtime_site_draft_operation_kinds(): array
{
    return array_keys(zeroy_runtime_site_draft_operation_contracts());
}

function zeroy_runtime_site_draft_operation_contracts(): array
{
    return [
        'artifact.files' => ['required' => ['artifact', 'files'], 'optional' => ['message']],
        'siteConfig' => ['required' => ['siteConfig', 'expectedRevision'], 'optional' => []],
        'createCanonical' => ['required' => ['ref', 'postType', 'schemaId', 'route'], 'optional' => ['postTitle', 'postContent', 'postExcerpt', 'templateContent']],
        'adoptCanonical' => ['required' => ['postId', 'schemaId', 'route', 'expectedSourceHash'], 'optional' => []],
        'retireCanonical' => ['required' => ['objectId', 'expectedRevision'], 'optional' => []],
        'assignSchema' => ['required' => ['objectRef', 'schemaId', 'expectedRevision'], 'optional' => []],
        'writeTemplateContent' => ['required' => ['objectRef', 'templateContent', 'expectedRevision'], 'optional' => []],
        'writeCanonicalContent' => ['required' => ['objectRef', 'expectedRevision'], 'optional' => ['postTitle', 'postContent', 'postExcerpt', 'route', 'acf']],
        'writeTranslationDraft' => ['required' => ['subject', 'locale', 'values', 'expectedRevision'], 'optional' => []],
        'publishTranslation' => ['required' => ['subject', 'locale', 'expectedRevision'], 'optional' => []],
        'unpublishTranslation' => ['required' => ['subject', 'locale', 'expectedRevision'], 'optional' => []],
    ];
}

function zeroy_runtime_site_draft_validate_object_keys(array $value, array $required, array $optional, string $scope): true|WP_Error
{
    $missing = array_values(array_filter($required, static fn(string $field): bool => !array_key_exists($field, $value)));
    if ($missing !== []) return zeroy_runtime_error('zeroy_site_draft_operation_invalid', "{$scope} requires fields: " . implode(', ', $missing) . '.', 400, ['fieldId' => $missing[0]]);
    $unknown = array_values(array_diff(array_keys($value), [...$required, ...$optional]));
    return $unknown === []
        ? true
        : zeroy_runtime_error('zeroy_site_draft_operation_invalid', "{$scope} has unknown fields: " . implode(', ', $unknown) . '.', 400, ['fieldId' => $unknown[0]]);
}

function zeroy_runtime_site_draft_valid_subject_ref(mixed $subject): bool
{
    if (!zeroy_runtime_is_keyed_map($subject) || !is_string($subject['kind'] ?? null)) return false;
    return match ($subject['kind']) {
        'post' => (is_int($subject['id'] ?? null) && $subject['id'] > 0) || (is_string($subject['ref'] ?? null) && preg_match('/^[a-z][a-z0-9_-]{0,63}$/', $subject['ref']) === 1),
        'term' => is_string($subject['taxonomy'] ?? null) && $subject['taxonomy'] !== '' && is_int($subject['id'] ?? null) && $subject['id'] > 0,
        'site-copy' => ($subject['id'] ?? null) === 'default',
        default => false,
    };
}

function zeroy_runtime_site_draft_valid_object_ref(mixed $reference): bool
{
    return (is_int($reference) && $reference > 0) || (is_string($reference) && preg_match('/^[a-z][a-z0-9_-]{0,63}$/', $reference) === 1);
}

function zeroy_runtime_site_draft_row(string $draft_id): ?array
{
    global $wpdb;
    $row = $wpdb->get_row(
        $wpdb->prepare(
            'SELECT * FROM ' . zeroy_runtime_table('site_drafts') . ' WHERE draft_id = %s',
            $draft_id,
        ),
        ARRAY_A,
    );
    return is_array($row) ? $row : null;
}

function zeroy_runtime_site_draft_operations(array $draft): array|WP_Error
{
    $operations = zeroy_runtime_decode_json((string) ($draft['operations_json'] ?? ''));
    if (is_wp_error($operations) || !array_is_list($operations)) {
        return zeroy_runtime_error('zeroy_site_draft_corrupt', 'SiteDraft operations are invalid.', 409);
    }
    foreach ($operations as $operation) {
        if (!zeroy_runtime_is_keyed_map($operation)) {
            return zeroy_runtime_error('zeroy_site_draft_corrupt', 'SiteDraft contains an invalid operation.', 409);
        }
    }
    return $operations;
}

function zeroy_runtime_validate_site_draft_operation(array $operation): true|WP_Error
{
    $kind = $operation['kind'] ?? null;
    $contracts = zeroy_runtime_site_draft_operation_contracts();
    if (!is_string($kind) || !isset($contracts[$kind])) {
        return zeroy_runtime_error('zeroy_site_draft_operation_invalid', 'Operation kind is not part of the SiteDraft contract.', 400, ['allowed' => zeroy_runtime_site_draft_operation_kinds()]);
    }
    if (!zeroy_runtime_is_keyed_map($operation['payload'] ?? null)) {
        return zeroy_runtime_error('zeroy_site_draft_operation_invalid', 'Operation payload must be a JSON object.', 400, ['kind' => $kind]);
    }
    $payload = $operation['payload'];
    $shape = zeroy_runtime_site_draft_validate_object_keys($payload, $contracts[$kind]['required'], $contracts[$kind]['optional'], $kind);
    if (is_wp_error($shape)) return $shape;
    if ($kind === 'artifact.files') {
        if (!in_array($payload['artifact'] ?? null, ['theme', 'site-logic'], true)) {
            return zeroy_runtime_error('zeroy_site_draft_operation_invalid', 'artifact.files requires artifact theme or site-logic.', 400, ['fieldId' => 'artifact', 'allowed' => ['theme', 'site-logic']]);
        }
        $files = $payload['files'] ?? null;
        if (!is_array($files) || !array_is_list($files) || $files === []) {
            return zeroy_runtime_error('zeroy_site_draft_operation_invalid', 'artifact.files requires a non-empty files array.', 400, ['fieldId' => 'files']);
        }
        foreach ($files as $file) {
            $has_content = is_array($file) && array_key_exists('content', $file);
            $has_expected_hash = is_array($file) && array_key_exists('expectedHash', $file);
            $content = $has_content ? $file['content'] : false;
            $expected_hash = $has_expected_hash ? $file['expectedHash'] : false;
            if (!zeroy_runtime_is_keyed_map($file) || !is_string($file['path'] ?? null) || (!$has_content || (!is_string($content) && $content !== null)) || (!$has_expected_hash || (!is_string($expected_hash) && $expected_hash !== null))) {
                return zeroy_runtime_error('zeroy_site_draft_operation_invalid', 'Each staged artifact file requires path, content, and expectedHash.', 400, ['kind' => $kind]);
            }
            if ($content === null && !is_string($expected_hash)) {
                return zeroy_runtime_error('zeroy_site_draft_operation_invalid', 'Deleting a staged artifact file requires its current expectedHash.', 400, ['kind' => $kind, 'path' => $file['path']]);
            }
            if (array_diff(array_keys($file), ['path', 'content', 'expectedHash']) !== []) return zeroy_runtime_error('zeroy_site_draft_operation_invalid', 'Each staged artifact file has unknown fields.', 400, ['kind' => $kind]);
        }
        if (array_key_exists('message', $payload) && !is_string($payload['message'])) return zeroy_runtime_error('zeroy_site_draft_operation_invalid', 'artifact.files message must be text.', 400, ['fieldId' => 'message']);
    } elseif ($kind === 'siteConfig') {
        if (!zeroy_runtime_is_keyed_map($payload['siteConfig']) || !is_int($payload['expectedRevision']) || $payload['expectedRevision'] < 0) return zeroy_runtime_error('zeroy_site_draft_operation_invalid', 'siteConfig requires a SiteConfig object and non-negative expectedRevision.', 400);
    } elseif ($kind === 'createCanonical') {
        if (!is_string($payload['ref']) || preg_match('/^[a-z][a-z0-9_-]{0,63}$/', $payload['ref']) !== 1 || !is_string($payload['postType']) || $payload['postType'] === '' || !is_string($payload['schemaId']) || $payload['schemaId'] === '' || !is_string($payload['route']) || $payload['route'] === '') return zeroy_runtime_error('zeroy_site_draft_operation_invalid', 'createCanonical requires a valid ref, postType, schemaId, and explicit route.', 400);
        foreach (['postTitle', 'postContent', 'postExcerpt'] as $field) if (array_key_exists($field, $payload) && !is_string($payload[$field])) return zeroy_runtime_error('zeroy_site_draft_operation_invalid', "{$kind} {$field} must be text.", 400, ['fieldId' => $field]);
        if (array_key_exists('templateContent', $payload) && (!zeroy_runtime_is_keyed_map($payload['templateContent']) || array_filter($payload['templateContent'], static fn(mixed $value): bool => !is_string($value)) !== [])) return zeroy_runtime_error('zeroy_site_draft_operation_invalid', 'createCanonical templateContent must be a string map.', 400, ['fieldId' => 'templateContent']);
    } elseif ($kind === 'adoptCanonical') {
        if (!is_int($payload['postId']) || $payload['postId'] < 1 || !is_string($payload['schemaId']) || $payload['schemaId'] === '' || !is_string($payload['route']) || $payload['route'] === '' || !is_string($payload['expectedSourceHash']) || preg_match('/^[a-f0-9]{64}$/', $payload['expectedSourceHash']) !== 1) return zeroy_runtime_error('zeroy_site_draft_operation_invalid', 'adoptCanonical requires postId, schemaId, explicit route, and expectedSourceHash.', 400);
    } elseif ($kind === 'retireCanonical') {
        if (!is_int($payload['objectId']) || $payload['objectId'] < 1 || !is_int($payload['expectedRevision']) || $payload['expectedRevision'] < 1) return zeroy_runtime_error('zeroy_site_draft_operation_invalid', 'retireCanonical requires objectId and positive expectedRevision.', 400);
    } elseif ($kind === 'assignSchema') {
        if (!zeroy_runtime_site_draft_valid_object_ref($payload['objectRef']) || !is_string($payload['schemaId']) || $payload['schemaId'] === '' || !is_int($payload['expectedRevision']) || $payload['expectedRevision'] < 0) return zeroy_runtime_error('zeroy_site_draft_operation_invalid', 'assignSchema requires objectRef, schemaId, and non-negative expectedRevision.', 400);
    } elseif ($kind === 'writeTemplateContent') {
        if (!zeroy_runtime_site_draft_valid_object_ref($payload['objectRef']) || !zeroy_runtime_is_keyed_map($payload['templateContent']) || array_filter($payload['templateContent'], static fn(mixed $value): bool => !is_string($value)) !== [] || !is_int($payload['expectedRevision']) || $payload['expectedRevision'] < 0) return zeroy_runtime_error('zeroy_site_draft_operation_invalid', 'writeTemplateContent requires objectRef, a string map, and non-negative expectedRevision.', 400);
    } elseif ($kind === 'writeCanonicalContent') {
        if (!zeroy_runtime_site_draft_valid_object_ref($payload['objectRef']) || !is_int($payload['expectedRevision']) || $payload['expectedRevision'] < 0 || array_diff(array_keys($payload), ['objectRef', 'expectedRevision']) === []) return zeroy_runtime_error('zeroy_site_draft_operation_invalid', 'writeCanonicalContent requires objectRef, expectedRevision, and at least one replacement value.', 400);
        foreach (['postTitle', 'postContent', 'postExcerpt', 'route'] as $field) if (array_key_exists($field, $payload) && !is_string($payload[$field])) return zeroy_runtime_error('zeroy_site_draft_operation_invalid', "writeCanonicalContent {$field} must be text.", 400, ['fieldId' => $field]);
        if (array_key_exists('acf', $payload) && !zeroy_runtime_is_keyed_map($payload['acf'])) return zeroy_runtime_error('zeroy_site_draft_operation_invalid', 'writeCanonicalContent acf must be an object.', 400, ['fieldId' => 'acf']);
    } else {
        if (!zeroy_runtime_site_draft_valid_subject_ref($payload['subject']) || !is_string($payload['locale']) || $payload['locale'] === '' || !is_int($payload['expectedRevision']) || $payload['expectedRevision'] < 0) return zeroy_runtime_error('zeroy_site_draft_operation_invalid', "{$kind} requires a supported subject, locale, and non-negative expectedRevision.", 400);
        if ($kind === 'writeTranslationDraft' && (!zeroy_runtime_is_keyed_map($payload['values']) || array_filter(array_keys($payload['values']), static fn(mixed $field_id): bool => !is_string($field_id) || !str_starts_with($field_id, '/')) !== [])) return zeroy_runtime_error('zeroy_site_draft_operation_invalid', 'writeTranslationDraft values must be a slash-keyed object.', 400, ['fieldId' => 'values']);
    }
    return true;
}

function zeroy_runtime_site_draft_subject_identity(mixed $subject): ?array
{
    if (!is_array($subject) || !is_string($subject['kind'] ?? null)) return null;
    if ($subject['kind'] === 'post') {
        if (is_int($subject['id'] ?? null) && $subject['id'] > 0) return ['key' => 'post:id:' . $subject['id'], 'kind' => 'post', 'objectId' => $subject['id']];
        if (is_string($subject['ref'] ?? null) && $subject['ref'] !== '') return ['key' => 'post:ref:' . $subject['ref'], 'kind' => 'post', 'ref' => $subject['ref'], 'objectId' => null];
    }
    if ($subject['kind'] === 'term' && is_string($subject['taxonomy'] ?? null) && is_int($subject['id'] ?? null) && $subject['id'] > 0) {
        return ['key' => 'term:' . $subject['taxonomy'] . ':' . $subject['id'], 'kind' => 'term', 'taxonomy' => $subject['taxonomy'], 'objectId' => $subject['id']];
    }
    if ($subject['kind'] === 'site-copy' && ($subject['id'] ?? null) === 'default') return ['key' => 'site-copy:default', 'kind' => 'site-copy', 'id' => 'default'];
    return null;
}

/**
 * Revision is not an independently stored Draft fact. The next legal
 * expectedRevision is a pure projection of the operation that just entered
 * the one Draft log. Returning it lets an Agent chain dependent operations
 * without guessing while commit still replays and checks the same log.
 */
function zeroy_runtime_site_draft_operation_next_revision(array $operation): ?int
{
    $kind = $operation['kind'] ?? null;
    $payload = $operation['payload'] ?? null;
    if (!is_string($kind) || !is_array($payload)) return null;
    if (in_array($kind, ['createCanonical', 'adoptCanonical'], true)) return 1;
    if ($kind === 'retireCanonical' || $kind === 'artifact.files' || $kind === 'replayDraft') return null;
    return is_int($payload['expectedRevision'] ?? null) ? $payload['expectedRevision'] + 1 : null;
}

/**
 * A receipt is a read-only view of the single Draft operation log. It does not
 * store a second impact ledger, so retries and failed candidates cannot drift
 * from the operations that actually define the SiteDraft.
 */
function zeroy_runtime_site_draft_affected_projection(array $operations): array
{
    $subjects = [];
    $artifacts = [];
    $add_subject = static function (?array $identity, string $operation, ?string $operation_id) use (&$subjects): void {
        if ($identity === null) return;
        $key = $identity['key'];
        unset($identity['key']);
        if (!isset($subjects[$key])) $subjects[$key] = [...$identity, 'operations' => []];
        if (!in_array($operation, $subjects[$key]['operations'], true)) $subjects[$key]['operations'][] = $operation;
        if ($operation_id !== null) $subjects[$key]['operationIds'][] = $operation_id;
    };
    foreach ($operations as $operation) {
        if (!is_array($operation) || !is_string($operation['kind'] ?? null) || !is_array($operation['payload'] ?? null)) continue;
        $kind = $operation['kind'];
        $payload = $operation['payload'];
        $operation_id = is_string($operation['operationId'] ?? null) ? $operation['operationId'] : null;
        if ($kind === 'artifact.files' && in_array($payload['artifact'] ?? null, ['theme', 'site-logic'], true)) {
            $artifact = $payload['artifact'];
            if (!isset($artifacts[$artifact])) $artifacts[$artifact] = ['kind' => $artifact, 'paths' => [], 'operationIds' => []];
            foreach (is_array($payload['files'] ?? null) ? $payload['files'] : [] as $file) {
                if (is_array($file) && is_string($file['path'] ?? null) && $file['path'] !== '') $artifacts[$artifact]['paths'][$file['path']] = true;
            }
            if ($operation_id !== null) $artifacts[$artifact]['operationIds'][] = $operation_id;
            continue;
        }
        if ($kind === 'siteConfig') {
            $add_subject(['key' => 'site-config:default', 'kind' => 'site-config', 'id' => 'default'], $kind, $operation_id);
            continue;
        }
        if ($kind === 'createCanonical' && is_string($payload['ref'] ?? null)) {
            $add_subject(['key' => 'post:ref:' . $payload['ref'], 'kind' => 'post', 'ref' => $payload['ref'], 'objectId' => null], $kind, $operation_id);
            continue;
        }
        if ($kind === 'adoptCanonical' && is_int($payload['postId'] ?? null)) {
            $add_subject(['key' => 'post:id:' . $payload['postId'], 'kind' => 'post', 'objectId' => $payload['postId']], $kind, $operation_id);
            continue;
        }
        if ($kind === 'retireCanonical' && is_int($payload['objectId'] ?? null)) {
            $add_subject(['key' => 'post:id:' . $payload['objectId'], 'kind' => 'post', 'objectId' => $payload['objectId']], $kind, $operation_id);
            continue;
        }
        if (in_array($kind, ['assignSchema', 'writeTemplateContent', 'writeCanonicalContent'], true)) {
            $reference = $payload['objectRef'] ?? null;
            $add_subject(
                is_int($reference) && $reference > 0
                    ? ['key' => 'post:id:' . $reference, 'kind' => 'post', 'objectId' => $reference]
                    : (is_string($reference) && $reference !== '' ? ['key' => 'post:ref:' . $reference, 'kind' => 'post', 'ref' => $reference, 'objectId' => null] : null),
                $kind,
                $operation_id,
            );
            continue;
        }
        if (in_array($kind, ['writeTranslationDraft', 'publishTranslation', 'unpublishTranslation'], true)) {
            $add_subject(zeroy_runtime_site_draft_subject_identity($payload['subject'] ?? null), $kind, $operation_id);
        }
    }
    return [
        'affectedSubjects' => array_values($subjects),
        'affectedArtifacts' => array_values(array_map(static function (array $artifact): array {
            $artifact['paths'] = array_keys($artifact['paths']);
            sort($artifact['paths'], SORT_STRING);
            return $artifact;
        }, $artifacts)),
    ];
}

/**
 * The operation log is the immutable SiteDraft truth. Tool receipts are not
 * another copy of that truth: they expose only the references, paths, and
 * resulting hashes an Agent needs to continue an open Draft. In particular,
 * returning staged file/content bytes here would make every stage response
 * grow with the whole Draft and turn a read receipt into a second content
 * transport.
 */
function zeroy_runtime_site_draft_operation_summaries(array $operations): array
{
    $summaries = [];
    foreach ($operations as $operation) {
        if (!is_array($operation) || !is_string($operation['kind'] ?? null) || !is_array($operation['payload'] ?? null)) continue;
        $kind = $operation['kind'];
        $payload = $operation['payload'];
        $summary = [
            'operationId' => is_string($operation['operationId'] ?? null) ? $operation['operationId'] : null,
            'ordinal' => is_int($operation['ordinal'] ?? null) ? $operation['ordinal'] : null,
            'kind' => $kind,
            'nextRevision' => zeroy_runtime_site_draft_operation_next_revision($operation),
        ];
        if ($kind === 'artifact.files') {
            $files = [];
            foreach (is_array($payload['files'] ?? null) ? $payload['files'] : [] as $file) {
                if (!is_array($file) || !is_string($file['path'] ?? null)) continue;
                $content = $file['content'] ?? null;
                $files[] = [
                    'path' => $file['path'],
                    'state' => $content === null ? 'deleted' : 'written',
                    'hash' => $content === null ? null : hash('sha256', (string) $content),
                ];
            }
            usort($files, static fn(array $left, array $right): int => strcmp($left['path'], $right['path']));
            $summaries[] = [...$summary, 'artifact' => $payload['artifact'] ?? null, 'files' => $files];
            continue;
        }
        if ($kind === 'createCanonical') {
            $summaries[] = [...$summary, 'ref' => $payload['ref'] ?? null, 'postType' => $payload['postType'] ?? null, 'schemaId' => $payload['schemaId'] ?? null, 'route' => $payload['route'] ?? null];
            continue;
        }
        if ($kind === 'adoptCanonical') {
            $summaries[] = [...$summary, 'postId' => $payload['postId'] ?? null, 'schemaId' => $payload['schemaId'] ?? null, 'route' => $payload['route'] ?? null];
            continue;
        }
        if (in_array($kind, ['retireCanonical', 'assignSchema', 'writeTemplateContent', 'writeCanonicalContent'], true)) {
            $fields = match ($kind) {
                'writeTemplateContent' => array_keys(is_array($payload['templateContent'] ?? null) ? $payload['templateContent'] : []),
                'writeCanonicalContent' => array_values(array_filter(['postTitle', 'postContent', 'postExcerpt', 'route', 'acf'], static fn(string $field): bool => array_key_exists($field, $payload))),
                default => [],
            };
            $summaries[] = [...$summary, 'objectRef' => $payload['objectRef'] ?? ($payload['objectId'] ?? null), 'schemaId' => $payload['schemaId'] ?? null, 'fields' => $fields];
            continue;
        }
        if (in_array($kind, ['writeTranslationDraft', 'publishTranslation', 'unpublishTranslation'], true)) {
            $summaries[] = [...$summary, 'subject' => $payload['subject'] ?? null, 'locale' => $payload['locale'] ?? null, 'fieldIds' => $kind === 'writeTranslationDraft' ? array_keys(is_array($payload['values'] ?? null) ? $payload['values'] : []) : []];
            continue;
        }
        $summaries[] = $summary;
    }
    return $summaries;
}

function zeroy_runtime_site_draft_receipt(array $draft): array|WP_Error
{
    $operations = zeroy_runtime_site_draft_operations($draft);
    if (is_wp_error($operations)) {
        return $operations;
    }
    $diagnostics = zeroy_runtime_decode_json((string) ($draft['diagnostics_json'] ?? ''));
    $last = $operations === [] ? null : $operations[count($operations) - 1];
    $staged_refs = [];
    foreach ($operations as $operation) {
        if (($operation['kind'] ?? null) === 'createCanonical' && is_array($operation['payload'] ?? null) && is_string($operation['payload']['ref'] ?? null)) {
            $staged_refs[$operation['payload']['ref']] = [
                'kind' => 'post',
                'ref' => $operation['payload']['ref'],
                'objectId' => null,
                'postType' => $operation['payload']['postType'] ?? null,
                'schemaId' => $operation['payload']['schemaId'] ?? null,
                'state' => 'staged',
            ];
        }
        if (($operation['kind'] ?? null) === 'adoptCanonical' && is_array($operation['payload'] ?? null) && is_int($operation['payload']['postId'] ?? null)) {
            $staged_refs['post:' . $operation['payload']['postId']] = [
                'kind' => 'post',
                'ref' => 'post:' . $operation['payload']['postId'],
                'objectId' => $operation['payload']['postId'],
                'schemaId' => $operation['payload']['schemaId'] ?? null,
                'state' => 'adoption-staged',
            ];
        }
        if (($operation['kind'] ?? null) === 'retireCanonical' && is_array($operation['payload'] ?? null) && is_int($operation['payload']['objectId'] ?? null)) {
            $staged_refs['post:' . $operation['payload']['objectId']] = [
                'kind' => 'post',
                'ref' => 'post:' . $operation['payload']['objectId'],
                'objectId' => $operation['payload']['objectId'],
                'state' => 'retirement-staged',
            ];
        }
    }
    $affected = zeroy_runtime_site_draft_affected_projection($operations);
    $operation_summaries = zeroy_runtime_site_draft_operation_summaries($operations);
    $last_operation = is_array($last) && is_string($last['operationId'] ?? null) && is_string($last['kind'] ?? null)
        ? [
            'operationId' => $last['operationId'],
            'kind' => $last['kind'],
            'nextRevision' => zeroy_runtime_site_draft_operation_next_revision($last),
        ]
        : null;
    $last_artifact_files = [];
    if (is_array($last) && ($last['kind'] ?? null) === 'artifact.files' && is_array($last['payload'] ?? null)) {
        $artifact = $last['payload']['artifact'] ?? null;
        foreach (($last['payload']['files'] ?? []) as $file) {
            if (!is_string($artifact) || !is_array($file) || !is_string($file['path'] ?? null)) continue;
            $content = $file['content'] ?? null;
            $last_artifact_files[] = [
                'artifact' => $artifact,
                'path' => $file['path'],
                'state' => $content === null ? 'deleted' : 'written',
                'hash' => $content === null ? null : hash('sha256', (string) $content),
            ];
        }
        usort($last_artifact_files, static fn(array $left, array $right): int => strcmp($left['path'], $right['path']));
    }
    return [
        'contract' => ZEROY_SITE_DRAFT_CONTRACT,
        'draftId' => (string) $draft['draft_id'],
        'baseReleaseId' => $draft['base_release_id'] !== null && $draft['base_release_id'] !== '' ? (string) $draft['base_release_id'] : null,
        'state' => (string) $draft['state'],
        'operationCount' => count($operations),
        'operationsHash' => zeroy_runtime_hash($operations),
        'lastOperation' => $last_operation,
        'proofId' => $draft['proof_id'] !== null && $draft['proof_id'] !== '' ? (string) $draft['proof_id'] : null,
        'replayedFromDraftId' => is_array($diagnostics) && is_string($diagnostics['replayedFromDraftId'] ?? null) ? $diagnostics['replayedFromDraftId'] : null,
        'diagnostics' => zeroy_runtime_json_map(is_wp_error($diagnostics) ? ['corrupt' => true] : $diagnostics),
        'operationSummaries' => $operation_summaries,
        'stagedRefs' => zeroy_runtime_json_map($staged_refs),
        'affectedSubjects' => $affected['affectedSubjects'],
        'affectedArtifacts' => $affected['affectedArtifacts'],
        'lastArtifactFiles' => $last_artifact_files,
        'createdAt' => (string) $draft['created_at'],
        'updatedAt' => (string) $draft['updated_at'],
    ];
}

function zeroy_runtime_site_draft_active_base(array $draft): array|WP_Error
{
    $active = zeroy_runtime_active_site_release();
    $base = $draft['base_release_id'] !== null && $draft['base_release_id'] !== '' ? (string) $draft['base_release_id'] : null;
    $current = is_array($active) ? (string) ($active['active_release_id'] ?? '') : null;
    if ($base !== $current) {
        return zeroy_runtime_error(
            'zeroy_site_draft_base_changed',
            'The active SiteRelease changed after this SiteDraft was created.',
            409,
            ['baseReleaseId' => $base, 'activeReleaseId' => $current],
        );
    }
    return $active ?? [];
}

/**
 * Content operations are only meaningful against the candidate ThemeSchema.
 * Validate the complete prospective log before persisting it, using the same
 * read-only candidate compiler that commit will later consume. Theme stages
 * remain freely composable while a ThemeSchema is incomplete; the first
 * content stage is the deliberate boundary that requires that contract.
 */
function zeroy_runtime_site_draft_preflight_content_append(array $draft, array $operations): true|WP_Error
{
    $candidate_draft = $draft;
    $candidate_draft['operations_json'] = zeroy_runtime_json($operations);
    $candidate = zeroy_runtime_site_draft_candidate_contract($candidate_draft);
    if (is_wp_error($candidate)) return $candidate;
    $theme_contract = $candidate['themeContract'] ?? null;
    $theme_schema = $candidate['themeSchema'] ?? null;
    if (!is_array($theme_contract) || !is_array($theme_schema)) {
        return zeroy_runtime_error('zeroy_site_draft_candidate_invalid', 'Candidate ThemeSchema is unavailable for a content operation.', 409);
    }
    $snapshot = zeroy_runtime_compile_draft_snapshot($candidate_draft, $theme_contract, $theme_schema);
    return is_wp_error($snapshot) ? $snapshot : true;
}

function zeroy_runtime_site_draft_owner_valid(string $owner_id): bool
{
    return preg_match('/\A[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}\z/', $owner_id) === 1;
}

function zeroy_runtime_site_draft_owned_by(array $draft, string $owner_id): true|WP_Error
{
    if (!zeroy_runtime_site_draft_owner_valid($owner_id)) {
        return zeroy_runtime_error('zeroy_site_draft_owner_invalid', 'SiteDraft owner identity is invalid.', 400, ['fieldId' => 'x-zeroy-draft-owner']);
    }
    if (!hash_equals((string) ($draft['owner_id'] ?? ''), $owner_id)) {
        return zeroy_runtime_error('zeroy_site_draft_missing', 'SiteDraft does not exist.', 404);
    }
    return true;
}

function zeroy_runtime_site_draft_open(string $draft_id, string $owner_id): array|WP_Error
{
    $draft = zeroy_runtime_site_draft_row($draft_id);
    if ($draft === null) {
        return zeroy_runtime_error('zeroy_site_draft_missing', 'SiteDraft does not exist.', 404);
    }
    if ((string) $draft['state'] !== 'open') {
        return zeroy_runtime_error('zeroy_site_draft_closed', 'SiteDraft is no longer open.', 409, ['state' => $draft['state']]);
    }
    $owned = zeroy_runtime_site_draft_owned_by($draft, $owner_id);
    if (is_wp_error($owned)) return $owned;
    $base = zeroy_runtime_site_draft_active_base($draft);
    return is_wp_error($base) ? $base : $draft;
}

function zeroy_runtime_site_draft_claim_commit(string $draft_id, ?string $expected_base_release_id, string $owner_id): array|WP_Error
{
    return zeroy_runtime_transaction(function () use ($draft_id, $expected_base_release_id, $owner_id) {
        global $wpdb;
        $draft = zeroy_runtime_site_draft_open($draft_id, $owner_id);
        if (is_wp_error($draft)) return $draft;
        $base_release_id = is_string($draft['base_release_id'] ?? null) && $draft['base_release_id'] !== '' ? $draft['base_release_id'] : null;
        if ($base_release_id !== $expected_base_release_id) {
            return zeroy_runtime_error('zeroy_site_draft_base_changed', 'SiteDraft base release does not match the commit request.', 409, ['draftId' => $draft_id, 'baseReleaseId' => $draft['base_release_id']]);
        }
        $updated_at = current_time('mysql', true);
        $updated = $wpdb->update(
            zeroy_runtime_table('site_drafts'),
            ['state' => 'committing', 'updated_at' => $updated_at],
            ['draft_id' => $draft_id, 'state' => 'open'],
            ['%s', '%s'],
            ['%s', '%s'],
        );
        if ($updated !== 1) return zeroy_runtime_error('zeroy_site_draft_conflict', 'SiteDraft changed while commit was starting.', 409, ['draftId' => $draft_id]);
        $claimed = zeroy_runtime_site_draft_row($draft_id);
        return $claimed === null ? zeroy_runtime_error('zeroy_site_draft_missing', 'SiteDraft disappeared while commit was starting.', 500) : $claimed;
    });
}

function zeroy_runtime_site_draft_reopen_after_commit_failure(string $draft_id): void
{
    global $wpdb;
    $wpdb->update(
        zeroy_runtime_table('site_drafts'),
        ['state' => 'open', 'updated_at' => current_time('mysql', true)],
        ['draft_id' => $draft_id, 'state' => 'committing'],
        ['%s', '%s'],
        ['%s', '%s'],
    );
}

/**
 * CandidateProof bytes have one owner: verification_proofs.  A SiteDraft keeps
 * only the identity of the proof compiled from its current immutable operation
 * log, so an Agent can recover from a failed commit through inspect draft
 * without creating a second diagnostic/proof store.
 */
function zeroy_runtime_bind_site_draft_proof(array $draft, string $release_id, string $proof_id, string $state, string $operations_hash, string $verified_at): true|WP_Error
{
    global $wpdb;
    $diagnostics = zeroy_runtime_decode_json((string) ($draft['diagnostics_json'] ?? ''));
    $diagnostics = is_wp_error($diagnostics) ? [] : $diagnostics;
    $diagnostics['latestCandidate'] = [
        'releaseId' => $release_id,
        'proofId' => $proof_id,
        'state' => $state,
        'operationsHash' => $operations_hash,
        'verifiedAt' => $verified_at,
    ];
    $updated = $wpdb->query(
        $wpdb->prepare(
            'UPDATE ' . zeroy_runtime_table('site_drafts') . ' SET proof_id = %s, diagnostics_json = %s, updated_at = %s WHERE draft_id = %s AND operations_json = %s AND state IN (\'open\', \'committing\')',
            $proof_id,
            zeroy_runtime_json($diagnostics),
            current_time('mysql', true),
            $draft['draft_id'],
            $draft['operations_json'],
        ),
    );
    if ($updated !== 1) {
        return zeroy_runtime_error(
            'zeroy_site_draft_proof_detached',
            'SiteDraft changed before its CandidateProof could be attached.',
            409,
            ['draftId' => $draft['draft_id'], 'releaseId' => $release_id, 'proofId' => $proof_id],
        );
    }
    return true;
}

function zeroy_runtime_create_site_draft(?string $expected_active_release_id, string $owner_id): array|WP_Error
{
    return zeroy_runtime_transaction(function () use ($expected_active_release_id, $owner_id) {
        global $wpdb;
        if (!zeroy_runtime_site_draft_owner_valid($owner_id)) {
            return zeroy_runtime_error('zeroy_site_draft_owner_invalid', 'SiteDraft owner identity is invalid.', 400, ['fieldId' => 'x-zeroy-draft-owner']);
        }
        $active = zeroy_runtime_active_site_release();
        $active_id = is_array($active) ? (string) ($active['active_release_id'] ?? '') : null;
        if ($expected_active_release_id !== null && $expected_active_release_id !== $active_id) {
            return zeroy_runtime_error(
                'zeroy_active_site_release_changed',
                'The active SiteRelease changed before this SiteDraft was created.',
                409,
                ['activeReleaseId' => $active_id],
            );
        }
        $now = current_time('mysql', true);
        $draft_id = wp_generate_uuid4();
        $written = $wpdb->insert(
            zeroy_runtime_table('site_drafts'),
            [
                'draft_id' => $draft_id,
                'owner_id' => $owner_id,
                'base_release_id' => $active_id,
                'state' => 'open',
                'operations_json' => zeroy_runtime_json([]),
                'proof_id' => null,
                'diagnostics_json' => zeroy_runtime_json([]),
                'created_at' => $now,
                'updated_at' => $now,
            ],
            ['%s', '%s', '%s', '%s', '%s', null, '%s', '%s', '%s'],
        );
        if ($written !== 1) {
            return zeroy_runtime_error('zeroy_site_draft_create_failed', $wpdb->last_error ?: 'Could not create SiteDraft.', 500);
        }
        $draft = zeroy_runtime_site_draft_row($draft_id);
        return $draft === null ? zeroy_runtime_error('zeroy_site_draft_create_failed', 'Created SiteDraft was not readable.', 500) : zeroy_runtime_site_draft_receipt($draft);
    });
}

function zeroy_runtime_append_site_draft_operation(string $draft_id, array $operation, string $owner_id): array|WP_Error
{
    return zeroy_runtime_transaction(function () use ($draft_id, $operation, $owner_id) {
        global $wpdb;
        $valid = zeroy_runtime_validate_site_draft_operation($operation);
        if (is_wp_error($valid)) return $valid;
        $draft = zeroy_runtime_site_draft_open($draft_id, $owner_id);
        if (is_wp_error($draft)) {
            return $draft;
        }
        $operations = zeroy_runtime_site_draft_operations($draft);
        if (is_wp_error($operations)) {
            return $operations;
        }
        if (($operation['kind'] ?? null) === 'artifact.files') {
            $base = zeroy_runtime_site_draft_active_base($draft);
            if (is_wp_error($base)) return $base;
            $artifact = $operation['payload']['artifact'] ?? null;
            if (!is_string($artifact)) return zeroy_runtime_error('zeroy_site_draft_operation_invalid', 'artifact.files requires an artifact kind.', 400, ['fieldId' => 'artifact']);
            $projected = zeroy_runtime_replay_site_draft_artifact_hashes($artifact, $base === [] ? null : $base, [...$operations, $operation]);
            if (is_wp_error($projected)) return $projected;
        }
        $operation['operationId'] = wp_generate_uuid4();
        $operation['ordinal'] = count($operations) + 1;
        $operations[] = $operation;
        if (($operation['kind'] ?? null) !== 'artifact.files') {
            $preflight = zeroy_runtime_site_draft_preflight_content_append($draft, $operations);
            if (is_wp_error($preflight)) return $preflight;
        }
        $diagnostics = zeroy_runtime_decode_json((string) ($draft['diagnostics_json'] ?? ''));
        $diagnostics = is_wp_error($diagnostics) ? [] : $diagnostics;
        $previous_proof_id = is_string($draft['proof_id'] ?? null) && $draft['proof_id'] !== ''
            ? $draft['proof_id']
            : null;
        $diagnostics['latestCandidate'] = [
            'state' => 'invalidated',
            'previousProofId' => $previous_proof_id,
            'reason' => 'draft_operation_appended',
        ];
        $updated_at = current_time('mysql', true);
        $updated = $wpdb->query(
            $wpdb->prepare(
                'UPDATE ' . zeroy_runtime_table('site_drafts') . ' SET operations_json = %s, proof_id = NULL, diagnostics_json = %s, updated_at = %s WHERE draft_id = %s AND state = %s',
                zeroy_runtime_json($operations),
                zeroy_runtime_json($diagnostics),
                $updated_at,
                $draft_id,
                'open',
            ),
        );
        if ($updated !== 1) {
            return zeroy_runtime_error('zeroy_site_draft_conflict', 'SiteDraft changed while appending an operation.', 409);
        }
        $next = zeroy_runtime_site_draft_row($draft_id);
        return $next === null ? zeroy_runtime_error('zeroy_site_draft_missing', 'SiteDraft disappeared after the operation was appended.', 500) : zeroy_runtime_site_draft_receipt($next);
    });
}

/**
 * A first stage is one state transition: either an operation is appended to a
 * fresh Draft based on the current active release, or nothing is persisted.
 * Creating an empty Draft and appending in a later HTTP request would split
 * that invariant across the network boundary.
 */
function zeroy_runtime_stage_site_draft_operation(?string $draft_id, array $operation, string $owner_id): array|WP_Error
{
    return zeroy_runtime_transaction(function () use ($draft_id, $operation, $owner_id) {
        $target_draft_id = $draft_id;
        if ($target_draft_id === null) {
            $created = zeroy_runtime_create_site_draft(null, $owner_id);
            if (is_wp_error($created)) return $created;
            $target_draft_id = (string) ($created['draftId'] ?? '');
            if ($target_draft_id === '') {
                return zeroy_runtime_error('zeroy_site_draft_create_failed', 'Created SiteDraft did not return a draftId.', 500);
            }
        }
        return zeroy_runtime_append_site_draft_operation($target_draft_id, $operation, $owner_id);
    });
}

function zeroy_runtime_discard_site_draft(string $draft_id, string $owner_id): array|WP_Error
{
    return zeroy_runtime_transaction(function () use ($draft_id, $owner_id) {
        global $wpdb;
        $draft = zeroy_runtime_site_draft_row($draft_id);
        if ($draft === null) {
            return zeroy_runtime_error('zeroy_site_draft_missing', 'SiteDraft does not exist.', 404);
        }
        $owned = zeroy_runtime_site_draft_owned_by($draft, $owner_id);
        if (is_wp_error($owned)) return $owned;
        if ((string) $draft['state'] !== 'open') {
            return zeroy_runtime_error('zeroy_site_draft_closed', 'SiteDraft is no longer open.', 409, ['state' => $draft['state']]);
        }
        $updated = $wpdb->update(
            zeroy_runtime_table('site_drafts'),
            ['state' => 'discarded', 'updated_at' => current_time('mysql', true)],
            ['draft_id' => $draft_id, 'state' => 'open'],
            ['%s', '%s'],
            ['%s', '%s'],
        );
        if ($updated !== 1) {
            return zeroy_runtime_error('zeroy_site_draft_conflict', 'SiteDraft changed while it was being discarded.', 409);
        }
        $next = zeroy_runtime_site_draft_row($draft_id);
        return $next === null ? zeroy_runtime_error('zeroy_site_draft_missing', 'SiteDraft disappeared after discard.', 500) : zeroy_runtime_site_draft_receipt($next);
    });
}

function zeroy_runtime_site_draft_replay_error(string $source_draft_id, ?string $active_release_id, WP_Error $cause): WP_Error
{
    return zeroy_runtime_error(
        'zeroy_site_draft_replay_conflict',
        'SiteDraft cannot be replayed onto the current active SiteRelease.',
        409,
        [
            'sourceDraftId' => $source_draft_id,
            'activeReleaseId' => $active_release_id,
            'cause' => [
                'code' => $cause->get_error_code(),
                'message' => $cause->get_error_message(),
                'data' => $cause->get_error_data(),
            ],
        ],
    );
}

/**
 * Rebase has exactly one meaning: replay the complete immutable operation log
 * against the current active release without rewriting any hash or revision
 * guard. A changed fact stays a conflict, never a silent last-writer-wins
 * merge.
 */
function zeroy_runtime_replay_site_draft(string $source_draft_id, string $owner_id): array|WP_Error
{
    return zeroy_runtime_transaction(function () use ($source_draft_id, $owner_id) {
        global $wpdb;
        $source = zeroy_runtime_site_draft_row($source_draft_id);
        if ($source === null) return zeroy_runtime_error('zeroy_site_draft_missing', 'SiteDraft does not exist.', 404);
        $owned = zeroy_runtime_site_draft_owned_by($source, $owner_id);
        if (is_wp_error($owned)) return $owned;
        if ((string) $source['state'] !== 'open') {
            return zeroy_runtime_error('zeroy_site_draft_closed', 'Only an open SiteDraft can be replayed.', 409, ['draftId' => $source_draft_id, 'state' => $source['state']]);
        }
        $active = zeroy_runtime_active_site_release();
        $active_id = is_array($active) ? (string) ($active['active_release_id'] ?? '') : null;
        $source_base = $source['base_release_id'] !== null && $source['base_release_id'] !== '' ? (string) $source['base_release_id'] : null;
        if ($source_base === $active_id) {
            return zeroy_runtime_error('zeroy_site_draft_replay_unnecessary', 'SiteDraft already uses the current active SiteRelease as its base.', 409, ['draftId' => $source_draft_id, 'baseReleaseId' => $source_base]);
        }
        $operations = zeroy_runtime_site_draft_operations($source);
        if (is_wp_error($operations)) return $operations;
        $target_id = wp_generate_uuid4();
        $target = [
            ...$source,
            'draft_id' => $target_id,
            'base_release_id' => $active_id,
            'state' => 'open',
            'proof_id' => null,
            'operations_json' => zeroy_runtime_json($operations),
            'diagnostics_json' => zeroy_runtime_json(['replayedFromDraftId' => $source_draft_id]),
        ];
        $compiled = zeroy_runtime_compile_site_draft($target, $active);
        if (is_wp_error($compiled)) return zeroy_runtime_site_draft_replay_error($source_draft_id, $active_id, $compiled);
        $theme_contract = zeroy_runtime_compile_theme_contract((string) $compiled['themeArtifactId'], (string) $compiled['siteLogicArtifactId']);
        if (is_wp_error($theme_contract)) return zeroy_runtime_site_draft_replay_error($source_draft_id, $active_id, $theme_contract);
        $snapshot = zeroy_runtime_compile_draft_snapshot($target, $theme_contract['contract'], $theme_contract['schema']);
        if (is_wp_error($snapshot)) return zeroy_runtime_site_draft_replay_error($source_draft_id, $active_id, $snapshot);
        $rechecked_active = zeroy_runtime_active_site_release();
        $rechecked_id = is_array($rechecked_active) ? (string) ($rechecked_active['active_release_id'] ?? '') : null;
        if ($rechecked_id !== $active_id) {
            return zeroy_runtime_error('zeroy_active_site_release_changed', 'The active SiteRelease changed while this Draft was being replayed.', 409, ['activeReleaseId' => $rechecked_id]);
        }
        $now = current_time('mysql', true);
        $source_diagnostics = zeroy_runtime_decode_json((string) $source['diagnostics_json']);
        $source_diagnostics = is_array($source_diagnostics) ? $source_diagnostics : [];
        $source_diagnostics['replayedToDraftId'] = $target_id;
        $source_updated = $wpdb->update(
            zeroy_runtime_table('site_drafts'),
            ['state' => 'replayed', 'diagnostics_json' => zeroy_runtime_json($source_diagnostics), 'updated_at' => $now],
            ['draft_id' => $source_draft_id, 'state' => 'open', 'operations_json' => (string) $source['operations_json']],
            ['%s', '%s', '%s'],
            ['%s', '%s', '%s'],
        );
        if ($source_updated !== 1) return zeroy_runtime_error('zeroy_site_draft_conflict', 'SiteDraft changed while it was being replayed.', 409, ['draftId' => $source_draft_id]);
        $written = $wpdb->insert(
            zeroy_runtime_table('site_drafts'),
            [
                'draft_id' => $target_id,
                'owner_id' => $owner_id,
                'base_release_id' => $active_id,
                'state' => 'open',
                'operations_json' => zeroy_runtime_json($operations),
                'proof_id' => null,
                'diagnostics_json' => zeroy_runtime_json(['replayedFromDraftId' => $source_draft_id]),
                'created_at' => $now,
                'updated_at' => $now,
            ],
            ['%s', '%s', '%s', '%s', '%s', null, '%s', '%s', '%s'],
        );
        if ($written !== 1) return zeroy_runtime_error('zeroy_site_draft_replay_failed', $wpdb->last_error ?: 'Could not create replayed SiteDraft.', 500);
        $target_row = zeroy_runtime_site_draft_row($target_id);
        return $target_row === null
            ? zeroy_runtime_error('zeroy_site_draft_replay_failed', 'Replayed SiteDraft was not readable.', 500)
            : zeroy_runtime_site_draft_receipt($target_row);
    });
}

function zeroy_runtime_commit_site_draft(string $draft_id, ?string $expected_base_release_id, string $message, string $owner_id): array|WP_Error
{
    $draft = zeroy_runtime_site_draft_claim_commit($draft_id, $expected_base_release_id, $owner_id);
    if (is_wp_error($draft)) return $draft;
    $restore = true;
    try {
        $operations = zeroy_runtime_site_draft_operations($draft);
        if (is_wp_error($operations)) return $operations;
        $active = zeroy_runtime_active_site_release();
        $compiled = zeroy_runtime_compile_site_draft($draft, $active);
        if (is_wp_error($compiled)) return $compiled;
        $release = zeroy_runtime_prepare_site_release(
            (string) $compiled['themeArtifactId'],
            (string) $compiled['siteLogicArtifactId'],
            $expected_base_release_id,
            ['source' => 'site-draft', 'draftId' => $draft_id, 'message' => $message],
            $draft_id,
        );
        if (is_wp_error($release)) return $release;
        if (($release['state'] ?? null) !== 'prepared') {
            return zeroy_runtime_error(
                'zeroy_site_commit_proof_failed',
                'CandidateProof blocked SiteDraft commit. The Draft remains open for repair.',
                409,
                [
                    'draftId' => $draft_id,
                    'releaseId' => $release['releaseId'] ?? null,
                    'proofId' => $release['proofId'] ?? null,
                    'diagnostics' => $release['diagnostics'] ?? null,
                    'affectedSubjects' => $release['affectedSubjects'] ?? [],
                    'affectedArtifacts' => $release['affectedArtifacts'] ?? [],
                ],
            );
        }
        $release_id = (string) ($release['releaseId'] ?? '');
        if ($release_id === '') return zeroy_runtime_error('zeroy_site_draft_commit_failed', 'Prepared SiteRelease did not return releaseId.', 500);
        $activated = zeroy_runtime_activate_site_release($release_id);
        if (is_wp_error($activated)) return $activated;
        $restore = false;
        return $activated;
    } finally {
        if ($restore) zeroy_runtime_site_draft_reopen_after_commit_failure($draft_id);
    }
}
