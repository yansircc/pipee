<?php

defined('ABSPATH') || exit;

function zeroy_runtime_site_endpoint(): WP_REST_Response
{
    $config = zeroy_runtime_site_config();
    $schema = zeroy_runtime_schema_diagnostics();
    return new WP_REST_Response([
        'contract' => 'zeroy/site@1',
        'runtimeVersion' => ZEROY_RUNTIME_VERSION,
        'siteId' => zeroy_runtime_site_id(),
        'siteConfig' => $config,
        'contentOwnership' => zeroy_runtime_content_ownership(),
        'themeSchema' => ['valid' => $schema['valid'], 'contractHash' => $schema['contractHash'] ?? null, 'schemaHashes' => $schema['schemaHashes'] ?? [], 'errors' => $schema['errors']],
        'themeAuthoring' => zeroy_runtime_theme_authoring_contract(),
        'siteLogicAuthoring' => zeroy_runtime_site_logic_authoring_contract(),
        'siteLogicBootstrap' => zeroy_runtime_site_logic_bootstrap_contract(),
        'capabilities' => ['siteConfig' => true, 'schema' => true, 'inventory' => true, 'acf' => true, 'adoptionCandidates' => true, 'existingPost' => true, 'canonicalContent' => true, 'themeArtifacts' => true, 'translationJob' => true, 'canonicalObjects' => true, 'siteDrafts' => true, 'integrity' => true],
    ]);
}

function zeroy_runtime_schema_endpoint(): WP_REST_Response
{
    $diagnostics = zeroy_runtime_schema_diagnostics();
    return $diagnostics['valid']
        ? new WP_REST_Response(['contract' => 'zeroy/schema@1', 'schema' => $diagnostics['schema'], 'contractHash' => $diagnostics['contractHash'], 'schemaHashes' => $diagnostics['schemaHashes']])
        : zeroy_runtime_response_error(zeroy_runtime_error('zeroy_schema_invalid', 'ThemeSchema is invalid.', 409, ['violations' => $diagnostics['errors']]));
}

function zeroy_runtime_inventory_endpoint(WP_REST_Request $request): WP_REST_Response
{
    return new WP_REST_Response(['contract' => 'zeroy/inventory@1', ...zeroy_runtime_inventory((int) $request->get_param('page'), (int) $request->get_param('perPage'))]);
}

function zeroy_runtime_acf_endpoint(): WP_REST_Response
{
    return new WP_REST_Response(['contract' => 'zeroy/acf@1', ...zeroy_runtime_acf_projection()]);
}

function zeroy_runtime_adoption_candidates_endpoint(WP_REST_Request $request): WP_REST_Response
{
    $result = zeroy_runtime_adoption_candidates($request->get_param('postType') ?: null, $request->get_param('schemaId') ?: null, (int) $request->get_param('page'), (int) $request->get_param('perPage'));
    return is_wp_error($result) ? zeroy_runtime_response_error($result) : new WP_REST_Response(['contract' => 'zeroy/adoption-candidates@1', ...$result]);
}

function zeroy_runtime_existing_post_candidate_definition(WP_REST_Request $request, ?string $schema_id): array|WP_Error|null
{
    $draft_id = $request->get_param('draftId');
    if ($draft_id === null || $draft_id === '') return null;
    if (!is_string($draft_id) || !preg_match('/^[a-f0-9-]{36}$/', $draft_id) || !is_string($schema_id) || $schema_id === '') {
        return zeroy_runtime_error('zeroy_site_draft_candidate_request_invalid', 'Candidate existing-post inspection requires draftId and schemaId.', 400, ['fieldId' => $schema_id === null || $schema_id === '' ? 'schemaId' : 'draftId']);
    }
    $draft = zeroy_runtime_site_draft_row($draft_id);
    if ($draft === null) return zeroy_runtime_error('zeroy_site_draft_missing', 'SiteDraft does not exist.', 404, ['draftId' => $draft_id]);
    $owner_id = zeroy_runtime_site_draft_request_owner($request);
    if (is_wp_error($owner_id)) return $owner_id;
    $owned = zeroy_runtime_site_draft_owned_by($draft, $owner_id);
    if (is_wp_error($owned)) return $owned;
    $candidate = zeroy_runtime_site_draft_candidate_contract($draft);
    if (is_wp_error($candidate)) return $candidate;
    $definition = $candidate['themeSchema']['schemas'][$schema_id] ?? null;
    return is_array($definition)
        ? $definition
        : zeroy_runtime_error('zeroy_schema_not_found', 'Candidate ThemeSchema does not define the requested schemaId.', 404, ['draftId' => $draft_id, 'schemaId' => $schema_id]);
}

function zeroy_runtime_existing_post_endpoint(WP_REST_Request $request): WP_REST_Response
{
    $schema_id = $request->get_param('schemaId');
    $schema_id = is_string($schema_id) && $schema_id !== '' ? $schema_id : null;
    $candidate_definition = zeroy_runtime_existing_post_candidate_definition($request, $schema_id);
    if (is_wp_error($candidate_definition)) return zeroy_runtime_response_error($candidate_definition);
    $result = zeroy_runtime_existing_unmanaged_post(
        (int) $request->get_param('postId'),
        $schema_id,
        $candidate_definition,
    );
    return is_wp_error($result) ? zeroy_runtime_response_error($result) : new WP_REST_Response(['contract' => 'zeroy/existing-post@1', 'existingPost' => $result]);
}

function zeroy_runtime_canonical_content_endpoint(WP_REST_Request $request): WP_REST_Response
{
    $canonical = zeroy_runtime_canonical((int) $request->get_param('objectId'));
    $config = is_wp_error($canonical) ? $canonical : zeroy_runtime_site_config();
    $content = is_wp_error($config) || is_wp_error($canonical)
        ? (is_wp_error($canonical) ? $canonical : $config)
        : zeroy_localization_post_content((int) $canonical['objectId'], $config['defaultLocale'], $canonical['schemaId']);
    return is_wp_error($content)
        ? zeroy_runtime_response_error($content)
        : new WP_REST_Response(['contract' => 'zeroy/canonical-content@1', 'canonical' => zeroy_runtime_canonical_projection($canonical), 'content' => $content]);
}

function zeroy_runtime_translation_job_endpoint(WP_REST_Request $request): WP_REST_Response
{
    $raw_subject = $request->get_param('subject');
    $subject = is_string($raw_subject) ? zeroy_runtime_decode_json($raw_subject) : $raw_subject;
    $result = is_array($subject) ? zeroy_localization_translation_job($subject, (string) $request->get_param('locale')) : zeroy_runtime_error('zeroy_translation_subject_invalid', 'subject must be a JSON object.', 400);
    return is_wp_error($result) ? zeroy_runtime_response_error($result) : new WP_REST_Response($result);
}
