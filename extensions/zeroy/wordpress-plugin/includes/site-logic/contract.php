<?php

defined('ABSPATH') || exit;

const ZEROY_SITE_LOGIC_CONTRACT = 'zeroy/site-logic-contract@1';
const ZEROY_SITE_LOGIC_MANIFEST_CONTRACT = 'zeroy/site-logic-manifest@1';
const ZEROY_SITE_LOGIC_ARTIFACT_CONTRACT = 'zeroy/site-logic-artifact@1';

function zeroy_runtime_site_logic_capability_kinds(): array
{
    return ['query', 'action'];
}

function zeroy_runtime_site_logic_effect_kinds(): array
{
    return ['read', 'write', 'external-request', 'background-job', 'file-write'];
}

function zeroy_runtime_site_logic_authorization_kinds(): array
{
    return ['public', 'authenticated'];
}

function zeroy_runtime_site_logic_bootstrap_contract(): array
{
    return [
        'contract' => 'zeroy/site-logic-bootstrap@1',
        'entrypoint' => 'bootstrap.php',
        'requiredGuard' => "defined('ABSPATH') || exit;",
        'topLevel' => [
            'allowed' => ['named-function-declaration', 'literal-capability-registration'],
            'forbidden' => ['arbitrary-statement', 'include', 'closure', 'top-level-effect'],
        ],
        'registration' => [
            'function' => 'zeroy_register_site_logic_capability',
            'arguments' => ['capability', 'majorVersion', 'namedHandler'],
            'capabilityPattern' => '^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$',
            'majorVersionPattern' => '^[1-9][0-9]*$',
            'namedHandlerPattern' => '^[a-zA-Z_][a-zA-Z0-9_]*$',
        ],
    ];
}

function zeroy_runtime_site_logic_authoring_contract(): array
{
    return [
        'contract' => 'zeroy/site-logic-authoring@1',
        'artifact' => [
            'requiredFiles' => ['bootstrap.php', 'sitelogic.json'],
            'entrypoint' => 'bootstrap.php',
            'manifest' => 'sitelogic.json',
        ],
        // The declaration program and immutable manifest describe one
        // SiteLogicArtifact. Keep their grammar under this single public
        // contract so an Agent never has to infer either half from source.
        'bootstrap' => zeroy_runtime_site_logic_bootstrap_contract(),
        'siteLogicContract' => [
            'contract' => ZEROY_SITE_LOGIC_CONTRACT,
            'required' => ['contract', 'provides', 'requires', 'storageEpoch', 'migrations'],
            'capability' => [
                'required' => ['capability', 'version', 'kind', 'outputSchema', 'effects', 'authorization', 'errors'],
                'optional' => ['inputSchema'],
                'capabilityPattern' => '^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$',
                'versionPattern' => '^[1-9][0-9]*$',
                'kinds' => zeroy_runtime_site_logic_capability_kinds(),
                'effects' => zeroy_runtime_site_logic_effect_kinds(),
                'authorizations' => zeroy_runtime_site_logic_authorization_kinds(),
                'schemaRule' => 'inputSchema when present and outputSchema always must be keyed JSON-schema-like objects.',
                'errors' => ['itemRequired' => ['code', 'retryable']],
            ],
            'requires' => [
                'itemRequired' => ['capability', 'version'],
                'versionPattern' => '^\^[1-9][0-9]*$',
            ],
            'migrations' => [
                'itemRequired' => ['fromEpoch', 'toEpoch', 'idempotencyKey', 'effects', 'verify', 'operations'],
                'effects' => 'schema-additive',
                'idempotencyKeyPattern' => '^[a-z][a-z0-9_.-]{0,95}$',
                'invariant' => 'Migrations are unique, form a forward epoch chain, and are verified before activation.',
            ],
        ],
        'runtimeCapabilities' => [
            ['capability' => 'locale.resolve', 'version' => '^1'],
            ['capability' => 'collection.query', 'version' => '^1'],
        ],
    ];
}

function zeroy_runtime_contract_has_only_keys(array $input, array $allowed): bool
{
    return array_diff(array_keys($input), $allowed) === [];
}

function zeroy_runtime_normalize_capability_reference(mixed $input): array|WP_Error
{
    if (!is_array($input) || array_is_list($input)) {
        return zeroy_runtime_error('zeroy_capability_reference_invalid', 'Capability references must be objects.', 400);
    }
    $capability = is_string($input['capability'] ?? null) ? $input['capability'] : '';
    $version = is_string($input['version'] ?? null) ? $input['version'] : '';
    if (!preg_match('/\A[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*\z/', $capability) || !preg_match('/\A\^[1-9][0-9]*\z/', $version)) {
        return zeroy_runtime_error(
            'zeroy_capability_reference_invalid',
            'Capability references require a stable capability name and a major version such as ^1.',
            400,
            ['capability' => $capability, 'version' => $version],
        );
    }
    return ['capability' => $capability, 'version' => $version];
}

function zeroy_runtime_normalize_site_logic_contract(mixed $input): array|WP_Error
{
    if (!is_array($input) || array_is_list($input) || !zeroy_runtime_contract_has_only_keys($input, ['contract', 'provides', 'requires', 'storageEpoch', 'migrations']) || ($input['contract'] ?? null) !== ZEROY_SITE_LOGIC_CONTRACT) {
        return zeroy_runtime_error('zeroy_site_logic_contract_invalid', 'sitelogic.json must contain the current SiteLogicContract.', 400);
    }
    $epoch = $input['storageEpoch'] ?? null;
    $provides = $input['provides'] ?? null;
    $requires = $input['requires'] ?? null;
    if (!is_int($epoch) || $epoch < 0 || !is_array($provides) || !array_is_list($provides) || !is_array($requires) || !array_is_list($requires)) {
        return zeroy_runtime_error('zeroy_site_logic_contract_invalid', 'SiteLogicContract requires non-negative storageEpoch plus list provides and requires fields.', 400);
    }
    $normalized_provides = [];
    foreach ($provides as $provided) {
        if (!is_array($provided) || array_is_list($provided) || !zeroy_runtime_contract_has_only_keys($provided, ['capability', 'version', 'kind', 'inputSchema', 'outputSchema', 'effects', 'authorization', 'errors'])) {
            return zeroy_runtime_error('zeroy_site_logic_contract_invalid', 'Each SiteLogic capability must be an object.', 400);
        }
        $capability = is_string($provided['capability'] ?? null) ? $provided['capability'] : '';
        $version = is_string($provided['version'] ?? null) ? $provided['version'] : '';
        $kind = $provided['kind'] ?? null;
        $effects = $provided['effects'] ?? null;
        $authorization = is_string($provided['authorization'] ?? null) ? $provided['authorization'] : '';
        $errors = $provided['errors'] ?? null;
        if (!preg_match('/\A[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*\z/', $capability) || !preg_match('/\A[1-9][0-9]*\z/', $version) || !in_array($kind, zeroy_runtime_site_logic_capability_kinds(), true) || !is_array($effects) || !array_is_list($effects) || !in_array($authorization, zeroy_runtime_site_logic_authorization_kinds(), true) || !is_array($errors) || !array_is_list($errors) || !zeroy_runtime_is_keyed_map($provided['outputSchema'] ?? null) || (array_key_exists('inputSchema', $provided) && !zeroy_runtime_is_keyed_map($provided['inputSchema']))) {
            return zeroy_runtime_error('zeroy_site_logic_contract_invalid', 'Each capability needs an identity, kind, declared effects, public/authenticated authorization, error algebra, and object outputSchema.', 400, ['capability' => $capability]);
        }
        $allowed_effects = zeroy_runtime_site_logic_effect_kinds();
        foreach ($effects as $effect) {
            if (!is_string($effect) || !in_array($effect, $allowed_effects, true)) {
                return zeroy_runtime_error('zeroy_site_logic_contract_invalid', 'SiteLogic capability effects are invalid.', 400, ['capability' => $capability]);
            }
        }
        foreach ($errors as $error) {
            if (!is_array($error) || !zeroy_runtime_contract_has_only_keys($error, ['code', 'retryable']) || !is_string($error['code'] ?? null) || !is_bool($error['retryable'] ?? null)) {
                return zeroy_runtime_error('zeroy_site_logic_contract_invalid', 'SiteLogic capability errors require code and retryable.', 400, ['capability' => $capability]);
            }
        }
        $identity = $capability . '@' . $version;
        if (isset($normalized_provides[$identity])) {
            return zeroy_runtime_error('zeroy_site_logic_contract_invalid', 'SiteLogic capabilities must be unique by capability and version.', 400, ['capability' => $capability, 'version' => $version]);
        }
        $normalized_provides[$identity] = [
            'capability' => $capability,
            'version' => $version,
            'kind' => $kind,
            'inputSchema' => $provided['inputSchema'] ?? null,
            'outputSchema' => $provided['outputSchema'],
            'effects' => array_values(array_unique($effects)),
            'authorization' => $authorization,
            'errors' => $errors,
        ];
    }
    $normalized_requires = [];
    foreach ($requires as $required) {
        $reference = zeroy_runtime_normalize_capability_reference($required);
        if (is_wp_error($reference)) {
            return $reference;
        }
        $identity = $reference['capability'] . '@' . $reference['version'];
        if (isset($normalized_requires[$identity])) {
            return zeroy_runtime_error('zeroy_site_logic_contract_invalid', 'SiteLogic required capabilities must be unique.', 400, $reference);
        }
        $normalized_requires[$identity] = $reference;
    }
    ksort($normalized_provides, SORT_STRING);
    ksort($normalized_requires, SORT_STRING);
    $migrations = $input['migrations'] ?? [];
    if (!is_array($migrations) || !array_is_list($migrations)) return zeroy_runtime_error('zeroy_site_logic_contract_invalid', 'SiteLogic migrations must be a list.', 400);
    $normalized_migrations = [];
    $migration_keys = [];
    $migration_edges = [];
    $migration_starts = [];
    foreach ($migrations as $migration) {
        if (!is_array($migration) || !zeroy_runtime_contract_has_only_keys($migration, ['fromEpoch', 'toEpoch', 'idempotencyKey', 'effects', 'verify', 'operations']) || !is_int($migration['fromEpoch'] ?? null) || $migration['fromEpoch'] < 0 || !is_int($migration['toEpoch'] ?? null) || $migration['toEpoch'] > $epoch || $migration['toEpoch'] <= $migration['fromEpoch'] || !is_string($migration['idempotencyKey'] ?? null) || !preg_match('/\A[a-z][a-z0-9_.-]{0,95}\z/', $migration['idempotencyKey']) || !is_string($migration['verify'] ?? null) || trim($migration['verify']) === '' || ($migration['effects'] ?? null) !== 'schema-additive' || !is_array($migration['operations'] ?? null) || !array_is_list($migration['operations']) || $migration['operations'] === []) {
            return zeroy_runtime_error('zeroy_site_logic_contract_invalid', 'SiteLogic migrations must declare an additive epoch transition and operations.', 400);
        }
        $edge = $migration['fromEpoch'] . ':' . $migration['toEpoch'];
        if (isset($migration_keys[$migration['idempotencyKey']]) || isset($migration_edges[$edge]) || isset($migration_starts[$migration['fromEpoch']])) {
            return zeroy_runtime_error('zeroy_site_logic_contract_invalid', 'SiteLogic migration keys, source epochs, and epoch transitions must be unique.', 400, ['idempotencyKey' => $migration['idempotencyKey']]);
        }
        $migration_keys[$migration['idempotencyKey']] = true;
        $migration_edges[$edge] = true;
        $migration_starts[$migration['fromEpoch']] = true;
        $normalized_migrations[] = ['fromEpoch' => $migration['fromEpoch'], 'toEpoch' => $migration['toEpoch'], 'idempotencyKey' => $migration['idempotencyKey'], 'effects' => 'schema-additive', 'verify' => trim($migration['verify']), 'operations' => $migration['operations']];
    }
    usort($normalized_migrations, static fn(array $left, array $right): int => $left['fromEpoch'] <=> $right['fromEpoch']);
    return [
        'contract' => ZEROY_SITE_LOGIC_CONTRACT,
        'provides' => array_values($normalized_provides),
        'requires' => array_values($normalized_requires),
        'storageEpoch' => $epoch,
        'migrations' => $normalized_migrations,
    ];
}

function zeroy_runtime_site_logic_contract_from_directory(string $directory): array|WP_Error
{
    $path = rtrim($directory, '/') . '/sitelogic.json';
    if (!is_file($path) || is_link($path)) {
        return zeroy_runtime_error('zeroy_site_logic_contract_missing', 'SiteLogicArtifact requires a regular sitelogic.json.', 409);
    }
    $decoded = zeroy_runtime_decode_json((string) file_get_contents($path));
    return is_wp_error($decoded) ? $decoded : zeroy_runtime_normalize_site_logic_contract($decoded);
}

function zeroy_runtime_capability_requirements_satisfied(array $requirements, array $contract): array|WP_Error
{
    $provided = [];
    foreach ($contract['provides'] as $capability) {
        $provided[$capability['capability'] . '@' . $capability['version']] = true;
    }
    $missing = [];
    foreach ($requirements as $requirement) {
        $reference = zeroy_runtime_normalize_capability_reference($requirement);
        if (is_wp_error($reference)) {
            return $reference;
        }
        $major = substr($reference['version'], 1);
        if (!isset($provided[$reference['capability'] . '@' . $major])) {
            $missing[] = $reference;
        }
    }
    return $missing;
}
