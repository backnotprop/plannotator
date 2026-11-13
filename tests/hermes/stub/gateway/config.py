from dataclasses import dataclass, field
from enum import Enum


class Platform(Enum):
    LOCAL = "local"
    TELEGRAM = "telegram"
    DISCORD = "discord"
    SLACK = "slack"
    SIGNAL = "signal"


@dataclass
class PlatformConfig:
    enabled: bool = False
    extra: dict = field(default_factory=dict)


@dataclass
class GatewayConfig:
    platforms: dict = field(default_factory=dict)


CURRENT = GatewayConfig()


def load_gateway_config():
    return CURRENT
