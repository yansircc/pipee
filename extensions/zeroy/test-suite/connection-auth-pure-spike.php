<?php

/**
 * Pure PHP spike for the Pipee connection authorization store.
 *
 * Exercises the grant/intent invariants without a live WordPress:
 * - grants persist only the irreversible hash;
 * - intents are short-lived, single-use, and bound to redirect + state;
 * - PKCE verifier must match the challenge;
 * - revocation rejects further use.
 */

define('ABSPATH', __DIR__ . '/');

// Minimal WordPress shims used by the store.
function wp_generate_uuid4(): string
{
    return sprintf(
        '%04x%04x-%04x-%04x-%04x-%04x%04x%04x',
        mt_rand(0, 0xffff),
        mt_rand(0, 0xffff),
        mt_rand(0, 0xffff),
        mt_rand(0, 0x0fff) | 0x4000,
        mt_rand(0, 0x3fff) | 0x8000,
        mt_rand(0, 0xffff),
        mt_rand(0, 0xffff),
        mt_rand(0, 0xffff),
    );
}

function wp_generate_password(int $length = 12, bool $special_chars = true, bool $extra_special_chars = false): string
{
    $chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    if ($special_chars) $chars .= '!@#$%^&*()';
    if ($extra_special_chars) $chars .= '-_ []{}<>~`+=,.;:/?|';
    $password = '';
    for ($i = 0; $i < $length; $i++) $password .= $chars[random_int(0, strlen($chars) - 1)];
    return $password;
}

function current_time(string $type, bool $gmt = false): string
{
    return $gmt ? gmdate('Y-m-d H:i:s') : date('Y-m-d H:i:s');
}

function is_wp_error(mixed $value): bool
{
    return $value instanceof WP_Error;
}

function zeroy_runtime_table(string $name): string
{
    return 'zeroy_' . $name;
}

function zeroy_runtime_error(string $code, string $message, int $status = 400): WP_Error
{
    return new WP_Error($code, $message, ['status' => $status]);
}

class WP_Error
{
    public function __construct(
        public string $code,
        public string $message,
        public array $data = [],
    ) {}
    public function get_error_code(): string
    {
        return $this->code;
    }
    public function get_error_message(): string
    {
        return $this->message;
    }
    public function get_error_data(): array
    {
        return $this->data;
    }
}

/**
 * In-memory $wpdb double for the store. Keyed inserts/updates only; the
 * authorization store uses insert/update/get_row/get_var/query via prepare.
 */
class WpdbDouble
{
    public array $tables = [];
    public ?string $last_error = null;

    public function prepare(string $query, ...$args): string
    {
        $index = 0;
        $out = preg_replace_callback('/%s/', function () use (&$index, $args) {
            $value = $args[$index] ?? '';
            $index++;
            return "'" . addslashes((string) $value) . "'";
        }, $query);
        return is_string($out) ? $out : $query;
    }

    public function insert(string $table, array $data, array $format): int|false
    {
        $this->tables[$table][] = $data;
        return 1;
    }

    public function update(string $table, array $data, array $where, array $format, array $where_format): int|false
    {
        foreach ($this->tables[$table] ?? [] as $index => $row) {
            $match = true;
            foreach ($where as $key => $value) {
                if (($row[$key] ?? null) !== $value) {
                    $match = false;
                    break;
                }
            }
            if ($match) {
                foreach ($data as $key => $value) $this->tables[$table][$index][$key] = $value;
                return 1;
            }
        }
        return 0;
    }

    public function get_row(string $query, string $output = ARRAY_A): ?array
    {
        if (preg_match('/FROM\s+(zeroy_[a-z_]+)\s+WHERE\s+(\w+)\s*=\s*\'([^\']*)\'/', $query, $matches) !== 1) return null;
        $table = $matches[1];
        $column = $matches[2];
        $value = stripslashes($matches[3]);
        foreach ($this->tables[$table] ?? [] as $row) {
            if (($row[$column] ?? null) === $value) return $row;
        }
        return null;
    }

    public function get_var(string $query): ?string
    {
        return null;
    }
}

$wpdb = new WpdbDouble();
define('ARRAY_A', 'ARRAY_A');

require_once dirname(__DIR__) . '/wordpress-plugin/includes/site-connection/auth-store.php';

function connection_spike_assert(bool $condition, string $message): void
{
    if (!$condition) throw new RuntimeException($message);
}

// --- grant store keeps only the irreversible hash ---
$grant_id = wp_generate_uuid4();
$grant_secret = 'grant-secret-plaintext';
$stored = zeroy_connection_insert_grant($grant_id, zeroy_connection_grant_hash($grant_secret), 'pipee-local', 'Local Pipee');
connection_spike_assert(!is_wp_error($stored), 'Grant insert failed.');
$grant = zeroy_connection_find_grant_by_hash(zeroy_connection_grant_hash($grant_secret));
connection_spike_assert(is_array($grant), 'Grant was not found by hash.');
connection_spike_assert(($grant['grant_hash'] ?? '') !== $grant_secret, 'Grant plaintext leaked into storage.');
connection_spike_assert(zeroy_connection_find_grant_by_hash($grant_secret) === null, 'Grant lookup accepted the plaintext as a hash.');
connection_spike_assert(!zeroy_connection_grant_is_revoked($grant), 'Fresh grant is unexpectedly revoked.');

// --- intent lifecycle: single use, state + redirect + PKCE bound ---
$intent = [
    'intentId' => wp_generate_uuid4(),
    'siteId' => wp_generate_uuid4(),
    'clientId' => 'pipee-local',
    'redirectUri' => 'http://127.0.0.1:30141/zeroy/connect/callback',
    'codeChallenge' => hash('sha256', 'the-verifier'),
    'state' => 'csrf-state',
    'expiresAt' => gmdate('Y-m-d H:i:s', time() + 600),
];
connection_spike_assert(!is_wp_error(zeroy_connection_insert_intent($intent)), 'Intent insert failed.');
connection_spike_assert(zeroy_connection_intent_is_valid(zeroy_connection_find_intent($intent['intentId'])), 'Fresh intent is invalid.');

// Wrong state is rejected and consumes nothing.
$wrong_state = zeroy_connection_exchange_code($intent['intentId'], 'code', 'the-verifier', 'wrong-state', $intent['redirectUri']);
connection_spike_assert(is_wp_error($wrong_state), 'Wrong state was accepted.');
connection_spike_assert(zeroy_connection_intent_is_valid(zeroy_connection_find_intent($intent['intentId'])), 'Rejected exchange consumed the intent.');

// Wrong verifier is rejected.
$wrong_verifier = zeroy_connection_exchange_code($intent['intentId'], 'code', 'not-the-verifier', $intent['state'], $intent['redirectUri']);
connection_spike_assert(is_wp_error($wrong_verifier), 'Wrong code verifier was accepted.');
connection_spike_assert(zeroy_connection_intent_is_valid(zeroy_connection_find_intent($intent['intentId'])), 'Rejected verifier consumed the intent.');

// Wrong redirect URI is rejected.
$wrong_redirect = zeroy_connection_exchange_code($intent['intentId'], 'code', 'the-verifier', $intent['state'], 'http://evil.test/callback');
connection_spike_assert(is_wp_error($wrong_redirect), 'Wrong redirect URI was accepted.');
connection_spike_assert(zeroy_connection_intent_is_valid(zeroy_connection_find_intent($intent['intentId'])), 'Rejected redirect consumed the intent.');

// Correct exchange produces a grant and consumes the intent.
$exchange = zeroy_connection_exchange_code($intent['intentId'], $grant_secret, 'the-verifier', $intent['state'], $intent['redirectUri']);
connection_spike_assert(!is_wp_error($exchange), 'Correct code exchange failed.');
connection_spike_assert(($exchange['contract'] ?? '') === 'zeroy/connection-grant@1', 'Exchange returned the wrong contract.');
connection_spike_assert(zeroy_connection_find_grant_by_hash(zeroy_connection_grant_hash($grant_secret)) !== null, 'Exchanged grant was not stored.');
connection_spike_assert(!zeroy_connection_intent_is_valid(zeroy_connection_find_intent($intent['intentId'])), 'Consumed intent is still valid.');

// Replay of the consumed intent is rejected.
$replay = zeroy_connection_exchange_code($intent['intentId'], 'code-again', 'the-verifier', $intent['state'], $intent['redirectUri']);
connection_spike_assert(is_wp_error($replay), 'Consumed intent was replayed.');

// --- revocation ---
$found = zeroy_connection_find_grant_by_hash(zeroy_connection_grant_hash($grant_secret));
connection_spike_assert(is_array($found), 'Grant for revocation not found.');
connection_spike_assert(!is_wp_error(zeroy_connection_revoke_grant((string) $found['grant_id'])), 'Revoke failed.');
$after = zeroy_connection_find_grant_by_hash(zeroy_connection_grant_hash($grant_secret));
connection_spike_assert(zeroy_connection_grant_is_revoked($after), 'Grant is not revoked after revoke.');

fwrite(STDOUT, "zeroY connection authorization store spike passed.\n");
