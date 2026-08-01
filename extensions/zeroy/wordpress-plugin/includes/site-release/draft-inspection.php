<?php

defined('ABSPATH') || exit;

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
