<?php

defined('ABSPATH') || exit;

function zeroy_runtime_site_draft_zcss_summary(array $draft): array|WP_Error|null
{
    if (!in_array((string) ($draft['state'] ?? ''), ['open', 'committing'], true)) return null;
    $active = zeroy_runtime_site_draft_active_base($draft);
    if (is_wp_error($active)) return $active;
    return zeroy_runtime_with_site_draft_artifact_directory(
        $draft,
        $active === [] ? null : $active,
        'theme',
        static function (string $directory): array|WP_Error {
            $path = rtrim($directory, '/') . '/' . ZEROY_ZCSS_COMPILED_MANIFEST_PATH;
            $compiled = is_file($path) ? zeroy_runtime_decode_json((string) file_get_contents($path)) : null;
            if (!is_array($compiled) || ($compiled['contract'] ?? null) !== ZEROY_ZCSS_COMPILED_CONTRACT) return zeroy_runtime_error('zeroy_zcss_output_invalid', 'Draft ZCSS compiled manifest is unavailable.', 409);
            return [
                'contract' => ZEROY_ZCSS_COMPILED_CONTRACT,
                'compiler' => $compiled['compiler'],
                'designHash' => $compiled['designHash'],
                'outputHash' => $compiled['outputHash'],
                'tokenCount' => count($compiled['tokens'] ?? []),
                'primitiveCount' => count($compiled['primitives'] ?? []),
                'warningCount' => count($compiled['warnings'] ?? []),
            ];
        },
    );
}

/**
 * Candidate discovery is a read-only projection of the same operation log
 * commit will compile. It never materializes an artifact, creates a release,
 * or changes the active pointer.
 */
function zeroy_runtime_site_draft_candidate_contract(array $draft): array|WP_Error
{
    $active = zeroy_runtime_site_draft_active_base($draft);
    if (is_wp_error($active)) return $active;
    $operations = zeroy_runtime_site_draft_operations($draft);
    if (is_wp_error($operations)) return $operations;
    $base_release = $active === [] ? null : $active;
    return zeroy_runtime_with_site_draft_artifact_directory(
        $draft,
        $base_release,
        'theme',
        static function (string $theme_directory, array $theme_manifest) use ($draft, $base_release, $operations): array|WP_Error {
            return zeroy_runtime_with_site_draft_artifact_directory(
                $draft,
                $base_release,
                'site-logic',
                static function (string $site_logic_directory, array $site_logic_manifest) use ($draft, $operations, $theme_directory, $theme_manifest): array|WP_Error {
                    $compiled = zeroy_runtime_compile_theme_contract_from_directories($theme_directory, $site_logic_directory);
                    if (is_wp_error($compiled)) return $compiled;
                    return [
                        'contract' => 'zeroy/site-draft-candidate@1',
                        'state' => 'ready',
                        'draftId' => (string) $draft['draft_id'],
                        'operationsHash' => zeroy_runtime_hash($operations),
                        'themeContract' => $compiled['contract'],
                        'themeSchema' => $compiled['schema'],
                        'themeSchemaHash' => $compiled['schemaHash'],
                        'siteLogicContract' => $compiled['siteLogicContract'],
                        'siteLogicContractHash' => $compiled['siteLogicContractHash'],
                        'acfProjection' => zeroy_runtime_acf_projection(),
                        'artifactManifests' => [
                            'theme' => $theme_manifest,
                            'siteLogic' => $site_logic_manifest,
                        ],
                    ];
                },
            );
        },
    );
}

function zeroy_runtime_site_draft_candidate_diagnostic(WP_Error $error): array
{
    $data = $error->get_error_data();
    return [
        'code' => $error->get_error_code(),
        'message' => $error->get_error_message(),
        'details' => is_array($data) ? array_diff_key($data, ['status' => true]) : [],
    ];
}

function zeroy_runtime_site_draft_inspection(array $draft): array|WP_Error
{
    $receipt = zeroy_runtime_site_draft_receipt($draft);
    if (is_wp_error($receipt)) return $receipt;
    if (!in_array((string) $draft['state'], ['open', 'committing'], true)) {
        return [
            'contract' => 'zeroy/site-draft-inspection@1',
            'draft' => $receipt,
            'candidate' => [
                'contract' => 'zeroy/site-draft-candidate@1',
                'state' => 'unavailable',
                'reason' => 'draft-not-open',
            ],
        ];
    }
    $candidate = zeroy_runtime_site_draft_candidate_contract($draft);
    return [
        'contract' => 'zeroy/site-draft-inspection@1',
        'draft' => $receipt,
        'candidate' => is_wp_error($candidate)
            ? [
                'contract' => 'zeroy/site-draft-candidate@1',
                'state' => 'invalid',
                'diagnostic' => zeroy_runtime_site_draft_candidate_diagnostic($candidate),
            ]
            : $candidate,
    ];
}
