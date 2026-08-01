<?php

defined('ABSPATH') || exit;

function zeroy_runtime_site_logic_registry(): array
{
    $registry = $GLOBALS['zeroy_runtime_site_logic_capabilities'] ?? [];
    return is_array($registry) ? $registry : [];
}

function zeroy_register_site_logic_capability(string $capability, string $version, string $handler): void
{
    $request = zeroy_runtime_request_site_release();
    if ($request === null) {
        throw new LogicException('SiteLogic capabilities may only register inside a pinned SiteRelease request.');
    }
    $artifact = zeroy_runtime_site_logic_artifact_row((string) $request['siteLogicArtifactId']);
    $contract = $artifact === null ? null : zeroy_runtime_decode_json((string) $artifact['contract_json']);
    if (!is_array($contract)) {
        throw new LogicException('Pinned SiteLogicArtifact has no valid contract.');
    }
    foreach ($contract['provides'] as $provided) {
        if ($provided['capability'] === $capability && $provided['version'] === $version) {
            if (!function_exists($handler)) {
                throw new LogicException('SiteLogic capability handler must be a named declared function.');
            }
            $registry = zeroy_runtime_site_logic_registry();
            $identity = $capability . '@' . $version;
            if (isset($registry[$identity])) throw new LogicException('A SiteLogic capability can register only once per request.');
            $registry[$identity] = ['contract' => $provided, 'handler' => $handler];
            $GLOBALS['zeroy_runtime_site_logic_capabilities'] = $registry;
            return;
        }
    }
    throw new LogicException('SiteLogicArtifact attempted to register a capability absent from its immutable contract.');
}

function zeroy_site_logic_call(string $capability, array $input): array|WP_Error
{
    $request = zeroy_runtime_request_site_release();
    if ($request === null) return zeroy_runtime_error('zeroy_site_logic_unavailable', 'SiteLogic is unavailable outside a pinned SiteRelease request.', 503);
    $registry = zeroy_runtime_site_logic_registry();
    $candidates = array_filter($registry, static fn(array $entry, string $identity): bool => str_starts_with($identity, $capability . '@'), ARRAY_FILTER_USE_BOTH);
    if (count($candidates) !== 1) return zeroy_runtime_error('zeroy_site_logic_capability_unavailable', 'Pinned SiteLogicArtifact does not provide the requested capability.', 503, ['capability' => $capability]);
    $entry = array_values($candidates)[0];
    $contract = $entry['contract'];
    if (($contract['authorization'] ?? null) === 'authenticated' && !is_user_logged_in()) return zeroy_runtime_error('zeroy_site_logic_unauthorized', 'This SiteLogic capability requires an authenticated WordPress user.', 401);
    if (is_array($contract['inputSchema'] ?? null) && function_exists('rest_validate_value_from_schema')) {
        $valid = rest_validate_value_from_schema($input, $contract['inputSchema'], $capability);
        if (is_wp_error($valid)) return zeroy_runtime_error('zeroy_site_logic_input_invalid', $valid->get_error_message(), 400);
    }
    $observation = zeroy_runtime_begin_site_logic_effect_observation();
    try {
        $output = ($entry['handler'])($input);
    } catch (Throwable $error) {
        zeroy_runtime_end_site_logic_effect_observation($observation);
        return zeroy_runtime_error('zeroy_site_logic_capability_failed', $error->getMessage(), 500, ['capability' => $capability]);
    }
    $observed = zeroy_runtime_end_site_logic_effect_observation($observation);
    $undeclared = array_values(array_diff($observed, $contract['effects']));
    if ($undeclared !== []) return zeroy_runtime_error('zeroy_site_logic_effect_undeclared', 'SiteLogic capability observed an undeclared effect.', 500, ['capability' => $capability, 'observedEffects' => $observed, 'undeclaredEffects' => $undeclared]);
    if (!is_array($output) || array_is_list($output)) return zeroy_runtime_error('zeroy_site_logic_output_invalid', 'SiteLogic capability output must be an object.', 500, ['capability' => $capability]);
    if (is_array($contract['outputSchema'] ?? null) && function_exists('rest_validate_value_from_schema')) {
        $valid = rest_validate_value_from_schema($output, $contract['outputSchema'], $capability . '.output');
        if (is_wp_error($valid)) return zeroy_runtime_error('zeroy_site_logic_output_invalid', $valid->get_error_message(), 500, ['capability' => $capability]);
    }
    return $output;
}
