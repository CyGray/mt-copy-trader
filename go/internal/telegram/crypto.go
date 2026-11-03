package telegram

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
)

const encryptedPrefix = "v1:"

var payloadAAD = []byte("bytrader/telegram/v1")

// EncryptCommandPayload encrypts Telegram login secrets with MASTER_KEY.
// The versioned envelope is nonce|tag|ciphertext, base64 encoded.
func EncryptCommandPayload(plaintext []byte) (string, error) {
	key, err := masterKey()
	if err != nil {
		return "", err
	}
	return encryptWithKey(plaintext, key)
}

// DecryptCommandPayload decrypts a payload previously produced by
// EncryptCommandPayload. It returns a generic error and never includes payload
// bytes or key material in an error message.
func DecryptCommandPayload(envelope string) ([]byte, error) {
	key, err := masterKey()
	if err != nil {
		return nil, err
	}
	return decryptWithKey(envelope, key)
}

func encryptWithKey(plaintext, key []byte) (string, error) {
	if len(key) != 32 {
		return "", errors.New("MASTER_KEY must decode to exactly 32 bytes")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", errors.New("initialize AES-GCM")
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", errors.New("initialize AES-GCM")
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", errors.New("generate encryption nonce")
	}
	sealed := gcm.Seal(nil, nonce, plaintext, payloadAAD)
	if len(sealed) < gcm.Overhead() {
		return "", errors.New("invalid AES-GCM result")
	}
	cut := len(sealed) - gcm.Overhead()
	packed := make([]byte, 0, len(nonce)+len(sealed))
	packed = append(packed, nonce...)
	packed = append(packed, sealed[cut:]...)
	packed = append(packed, sealed[:cut]...)
	return encryptedPrefix + base64.StdEncoding.EncodeToString(packed), nil
}

func decryptWithKey(envelope string, key []byte) ([]byte, error) {
	if len(key) != 32 {
		return nil, errors.New("MASTER_KEY must decode to exactly 32 bytes")
	}
	if !strings.HasPrefix(envelope, encryptedPrefix) {
		return nil, errors.New("unsupported encrypted Telegram payload version")
	}
	packed, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(envelope, encryptedPrefix))
	if err != nil {
		return nil, errors.New("invalid encrypted Telegram payload")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, errors.New("initialize AES-GCM")
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, errors.New("initialize AES-GCM")
	}
	minimum := gcm.NonceSize() + gcm.Overhead()
	if len(packed) < minimum {
		return nil, errors.New("invalid encrypted Telegram payload")
	}
	nonce := packed[:gcm.NonceSize()]
	tagStart := gcm.NonceSize()
	tagEnd := tagStart + gcm.Overhead()
	sealed := make([]byte, 0, len(packed)-gcm.NonceSize())
	sealed = append(sealed, packed[tagEnd:]...)
	sealed = append(sealed, packed[tagStart:tagEnd]...)
	plaintext, err := gcm.Open(nil, nonce, sealed, payloadAAD)
	if err != nil {
		return nil, errors.New("encrypted Telegram payload authentication failed")
	}
	return plaintext, nil
}

func masterKey() ([]byte, error) {
	value := strings.TrimSpace(os.Getenv("MASTER_KEY"))
	if value == "" {
		return nil, errors.New("MASTER_KEY is required for Telegram encrypted storage")
	}
	if len(value) == 64 {
		if decoded, err := hex.DecodeString(value); err == nil && len(decoded) == 32 {
			return decoded, nil
		}
	}
	for _, encoding := range []*base64.Encoding{base64.StdEncoding, base64.RawStdEncoding, base64.URLEncoding, base64.RawURLEncoding} {
		decoded, err := encoding.DecodeString(value)
		if err == nil && len(decoded) == 32 {
			return decoded, nil
		}
	}
	return nil, fmt.Errorf("MASTER_KEY must be 64 hex characters or base64 for exactly 32 bytes")
}
