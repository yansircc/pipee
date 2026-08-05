import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

const projectionPath = fileURLToPath(
  new URL("../wordpress-plugin/includes/site-release/snapshot-projection.php", import.meta.url),
);

const phpString = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

describe("SiteSnapshot request projection spike", () => {
  it("projects singular, archive, search, locale links, and ACF content without live WordPress reads", () => {
    const source = readFileSync(projectionPath, "utf8");
    for (const forbidden of [
      "get_post(",
      "get_posts(",
      "get_terms(",
      "get_term_by(",
      "WP_Query",
      "$wpdb",
    ]) {
      expect(source).not.toContain(forbidden);
    }

    const program = `
      define('ABSPATH', '/');
      final class WP_Error {}
      function is_wp_error(mixed $value): bool { return $value instanceof WP_Error; }
      function zeroy_runtime_error(string $code, string $message, int $status, array $details = []): WP_Error { throw new RuntimeException($code . ':' . $message); }
      function zeroy_runtime_hash(mixed $value): string { return hash('sha256', json_encode($value, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)); }
      function zeroy_runtime_preview_release_context(): ?array { return $GLOBALS['zeroy_test_preview'] ?? null; }
      function zeroy_runtime_admin_preview_url(string $release_id, string $route = ''): string { $suffix = trim($route, '/'); return 'https://example.test/__zeroy-preview/' . $release_id . ($suffix === '' ? '/' : '/' . $suffix . '/'); }
      require ${phpString(projectionPath)};
      $enItem = ['objectId' => 'draft:machine-1', 'locale' => 'en', 'schemaId' => 'machine', 'url' => 'https://example.test/machines/press/', 'fields' => ['post' => ['title' => 'Press', 'excerpt' => 'Industrial press'], 'acf' => ['capacity' => '20 t/h']]];
      $zhItem = ['objectId' => 'draft:machine-1', 'locale' => 'zh', 'schemaId' => 'machine', 'url' => 'https://example.test/zh/machines/press/', 'fields' => ['post' => ['title' => '压机', 'excerpt' => '工业压机'], 'acf' => ['capacity' => '20 吨/时']]];
      $snapshot = [
        'contract' => ZEROY_SITE_SNAPSHOT_CONTRACT,
        'site' => ['baseUrl' => 'https://example.test', 'defaultLocale' => 'en', 'enabledLocales' => [['locale' => 'en', 'urlPrefix' => ''], ['locale' => 'zh', 'urlPrefix' => 'zh']]],
        'routes' => [
          'en' => [
            'machines/press' => ['routeId' => 'post:draft:machine-1', 'routeKind' => 'singular', 'route' => 'machines/press', 'template' => 'machine.php', 'subject' => ['kind' => 'post', 'ref' => 'draft:machine-1', 'schemaId' => 'machine'], 'resolvedContent' => $enItem['fields']],
            'machines' => ['routeId' => 'collection:machines', 'routeKind' => 'archive', 'route' => 'machines', 'template' => 'archive.php', 'collectionId' => 'machines', 'schemaId' => 'machine', 'title' => 'Machines', 'items' => [$enItem]],
            'search' => ['routeId' => 'search', 'routeKind' => 'search', 'route' => 'search', 'template' => 'search.php'],
          ],
          'zh' => [
            'machines/press' => ['routeId' => 'post:draft:machine-1', 'routeKind' => 'singular', 'route' => 'machines/press', 'template' => 'machine.php', 'subject' => ['kind' => 'post', 'ref' => 'draft:machine-1', 'schemaId' => 'machine'], 'resolvedContent' => $zhItem['fields']],
            'machines' => ['routeId' => 'collection:machines', 'routeKind' => 'archive', 'route' => 'machines', 'template' => 'archive.php', 'collectionId' => 'machines', 'schemaId' => 'machine', 'title' => '设备', 'items' => [$zhItem]],
            'search' => ['routeId' => 'search', 'routeKind' => 'search', 'route' => 'search', 'template' => 'search.php'],
          ],
        ],
        'notFound' => [
          'en' => ['routeId' => 'not-found', 'routeKind' => 'not-found', 'route' => '', 'template' => '404.php'],
          'zh' => ['routeId' => 'not-found', 'routeKind' => 'not-found', 'route' => '', 'template' => '404.php'],
        ],
        'routeUrls' => [
          'post:draft:machine-1' => ['en' => 'machines/press', 'zh' => 'machines/press'],
          'collection:machines' => ['en' => 'machines', 'zh' => 'machines'],
          'search' => ['en' => 'search', 'zh' => 'search'],
          'not-found' => ['en' => null, 'zh' => null],
        ],
        'searchItems' => ['en' => [$enItem], 'zh' => [$zhItem]],
      ];
      $singular = zeroy_runtime_snapshot_context($snapshot, '/zh/machines/press/');
      $archive = zeroy_runtime_snapshot_context($snapshot, '/machines/');
      $search = zeroy_runtime_snapshot_context($snapshot, '/zh/search/', ['s' => '压机']);
      $nativePermalink = zeroy_runtime_snapshot_context($snapshot, '/zeroy-243/');
      if ($singular['context']['resolvedContent']['acf']['capacity'] !== '20 吨/时') throw new RuntimeException('acf projection failed');
      if ($singular['context']['seo']['alternates'][0]['url'] !== 'https://example.test/machines/press/') throw new RuntimeException('locale links failed');
      if (count($archive['context']['archiveItems']) !== 1 || $archive['context']['routeKind'] !== 'archive') throw new RuntimeException('archive projection failed');
      if (count($search['context']['archiveItems']) !== 1 || $search['context']['searchQuery'] !== '压机') throw new RuntimeException('search projection failed');
      if ($nativePermalink['context']['routeKind'] !== 'not-found' || $nativePermalink['context']['seo']['canonical'] !== null) throw new RuntimeException('undeclared native permalink became a second public URL');
      if ($singular['projectionHash'] === $search['projectionHash']) throw new RuntimeException('projection identity failed');
      $GLOBALS['zeroy_test_preview'] = ['kind' => 'administrator-preview', 'release' => ['release_id' => '11111111-1111-4111-8111-111111111111']];
      $preview = zeroy_runtime_snapshot_context($snapshot, '/zh/machines/press/');
      if ($preview['context']['seo']['alternates'][0]['url'] !== 'https://example.test/__zeroy-preview/11111111-1111-4111-8111-111111111111/machines/press/') throw new RuntimeException('preview alternates escaped candidate release');
      if ($preview['context']['resolvedContent']['_site']['homeUrls']['zh'] !== 'https://example.test/__zeroy-preview/11111111-1111-4111-8111-111111111111/zh/') throw new RuntimeException('preview home URL escaped candidate release');
      if ($preview['context']['resolvedContent']['_site']['routeUrls']['collection:machines']['zh'] !== 'https://example.test/__zeroy-preview/11111111-1111-4111-8111-111111111111/zh/machines/') throw new RuntimeException('preview route URL escaped candidate release');
      echo 'ok';
    `;
    expect(execFileSync("php", ["-r", program], { encoding: "utf8" })).toBe("ok");
  });
});
