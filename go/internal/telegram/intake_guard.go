package telegram

import (
	"context"
	"sync"
)

// intakeGuard stops the current update-manager run when a durable intake
// transaction fails. gotd logs handler errors while advancing in-memory pts;
// cancellation makes the subsequent cursor write use a canceled context, so a
// restart reloads the prior persisted cursor and receives the update again.
type intakeGuard struct {
	cancel context.CancelFunc
	once   sync.Once
	fail   chan error
}

func newIntakeGuard(cancel context.CancelFunc) *intakeGuard {
	return &intakeGuard{cancel: cancel, fail: make(chan error, 1)}
}

func (g *intakeGuard) handle(fn func() error) error {
	err := fn()
	if err != nil {
		g.once.Do(func() {
			g.fail <- err
			g.cancel()
		})
	}
	return err
}

func (g *intakeGuard) failure() error {
	select {
	case err := <-g.fail:
		return err
	default:
		return nil
	}
}
