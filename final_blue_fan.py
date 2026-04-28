from machine import Pin, PWM
import bluetooth
import struct
import time


DEVICE_NAME = "LC_ESP32S3_FAN"
LED_PIN = 48
PWM_FREQ = 1000
ADVERTISE_REFRESH_MS = 3000
CONNECTED_HEARTBEAT_MS = 5000
STALE_CONNECTION_MS = 60000
FAN_RUN_MS = 20000
BLE_RESET_DELAY_MS = 120

UART_UUID = bluetooth.UUID("6E400001-B5A3-F393-E0A9-E50E24DCCA9E")
UART_TX = (
    bluetooth.UUID("6E400003-B5A3-F393-E0A9-E50E24DCCA9E"),
    bluetooth.FLAG_NOTIFY,
)
UART_RX = (
    bluetooth.UUID("6E400002-B5A3-F393-E0A9-E50E24DCCA9E"),
    bluetooth.FLAG_WRITE | bluetooth.FLAG_WRITE_NO_RESPONSE,
)
UART_SERVICE = (
    UART_UUID,
    (UART_TX, UART_RX),
)

IRQ_CENTRAL_CONNECT = 1
IRQ_CENTRAL_DISCONNECT = 2
IRQ_GATTS_WRITE = 3

ADV_TYPE_FLAGS = 0x01
ADV_TYPE_NAME = 0x09
ADV_TYPE_UUID128_COMPLETE = 0x07

DUTY_TABLE = {
    0: 0,
    70: int(65535 * 0.70),
    85: int(65535 * 0.85),
    100: 65535,
}


def append_adv_field(payload, adv_type, value):
    payload += struct.pack("BB", len(value) + 1, adv_type)
    payload += value


def advertising_payload(name=None, services=None):
    payload = bytearray()
    append_adv_field(payload, ADV_TYPE_FLAGS, b"\x06")

    if name:
        append_adv_field(payload, ADV_TYPE_NAME, name.encode())

    if services:
        for uuid in services:
            uuid_bytes = bytes(uuid)
            if len(uuid_bytes) == 16:
                append_adv_field(payload, ADV_TYPE_UUID128_COMPLETE, uuid_bytes)

    return payload


led = Pin(LED_PIN, Pin.OUT)
led.value(1)

fans = {
    1: PWM(Pin(1), freq=PWM_FREQ),
    2: PWM(Pin(2), freq=PWM_FREQ),
    3: PWM(Pin(3), freq=PWM_FREQ),
    4: PWM(Pin(4), freq=PWM_FREQ),
}

fan_status = {
    1: 0,
    2: 0,
    3: 0,
    4: 0,
}

for fan in fans.values():
    fan.duty_u16(0)


class BleFanController:
    def __init__(self, name=DEVICE_NAME):
        self.name = name
        self.ble = bluetooth.BLE()
        self.reset_ble_stack()
        self.ble.active(True)
        self.ble.config(gap_name=self.name)
        self.ble.irq(self.irq)

        ((self.tx_handle, self.rx_handle),) = self.ble.gatts_register_services(
            (UART_SERVICE,)
        )
        try:
            self.ble.gatts_set_buffer(self.rx_handle, 256, True)
        except Exception as exc:
            print("RX buffer config skipped:", exc)

        self.connections = set()
        self.last_advertise_ms = 0
        self.last_activity_ms = time.ticks_ms()
        self.last_heartbeat_ms = time.ticks_ms()
        self.fan_stop_deadline_ms = None
        self.adv_payload = advertising_payload(services=[UART_UUID])
        self.resp_payload = advertising_payload(name=self.name)
        self.advertise()

    def reset_ble_stack(self):
        try:
            self.ble.gap_advertise(None)
        except Exception:
            pass

        try:
            self.ble.active(False)
            time.sleep_ms(BLE_RESET_DELAY_MS)
        except Exception as exc:
            print("BLE reset skipped:", exc)

    def irq(self, event, data):
        if event == IRQ_CENTRAL_CONNECT:
            conn_handle, _, _ = data
            self.connections.add(conn_handle)
            self.last_activity_ms = time.ticks_ms()
            self.last_heartbeat_ms = time.ticks_ms()
            led.value(0)
            print("BLE client connected:", conn_handle)

        elif event == IRQ_CENTRAL_DISCONNECT:
            conn_handle, _, _ = data
            self.release_connection(conn_handle)
            print("BLE client disconnected:", conn_handle)
            self.advertise()

        elif event == IRQ_GATTS_WRITE:
            conn_handle, value_handle = data
            if value_handle != self.rx_handle:
                return

            try:
                self.last_activity_ms = time.ticks_ms()
                payload = self.ble.gatts_read(self.rx_handle).decode()
                payload = payload.replace("\r", "\n")
                for message in payload.split("\n"):
                    message = message.strip()
                    if not message:
                        continue
                    print("RX:", message)
                    self.handle_command(message)
            except Exception as exc:
                print("Command decode failed:", exc)
                self.send("ERROR: decode failed")

    def advertise(self):
        print("Advertising as", self.name)
        self.last_advertise_ms = time.ticks_ms()
        try:
            self.ble.gap_advertise(None)
            time.sleep_ms(80)
        except Exception as exc:
            print("Advertising stop skipped:", exc)

        self.ble.gap_advertise(
            100000,
            adv_data=self.adv_payload,
            resp_data=self.resp_payload,
        )

    def ensure_advertising(self):
        now = time.ticks_ms()

        if self.connections:
            self.ensure_connection_alive(now)
            return

        if time.ticks_diff(now, self.last_advertise_ms) > ADVERTISE_REFRESH_MS:
            self.advertise()

    def ensure_connection_alive(self, now):
        if time.ticks_diff(now, self.last_heartbeat_ms) > CONNECTED_HEARTBEAT_MS:
            self.last_heartbeat_ms = now
            self.send_status()

        if time.ticks_diff(now, self.last_activity_ms) > STALE_CONNECTION_MS:
            print("BLE connection stale; disconnecting clients")
            for conn_handle in list(self.connections):
                self.disconnect_connection(conn_handle)

    def release_connection(self, conn_handle):
        self.connections.discard(conn_handle)
        if not self.connections:
            led.value(1)
            self.stop_all_fans("BLE disconnected")

    def disconnect_connection(self, conn_handle, restart_advertising=True):
        try:
            self.ble.gap_disconnect(conn_handle)
        except Exception as exc:
            print("BLE disconnect skipped:", exc)
        self.release_connection(conn_handle)
        if restart_advertising and not self.connections:
            self.advertise()

    def shutdown(self):
        print("BLE fan controller shutting down")
        self.stop_all_fans("Controller shutdown")

        for conn_handle in list(self.connections):
            self.disconnect_connection(conn_handle, False)

        try:
            self.ble.gap_advertise(None)
        except Exception as exc:
            print("Advertising stop skipped:", exc)

        try:
            self.ble.active(False)
        except Exception as exc:
            print("BLE shutdown skipped:", exc)

    def stop_all_fans(self, reason):
        print(reason + "; stopping all fans")
        for fan_id in fans:
            fans[fan_id].duty_u16(0)
            fan_status[fan_id] = 0
        self.fan_stop_deadline_ms = None

    def update_fan_run_timer(self):
        if any(speed > 0 for speed in fan_status.values()):
            self.fan_stop_deadline_ms = time.ticks_add(time.ticks_ms(), FAN_RUN_MS)
            print("Fan auto-stop scheduled in {} ms".format(FAN_RUN_MS))
        else:
            self.fan_stop_deadline_ms = None

    def check_fan_auto_stop(self):
        if self.fan_stop_deadline_ms is None:
            return

        if time.ticks_diff(time.ticks_ms(), self.fan_stop_deadline_ms) >= 0:
            self.stop_all_fans("Fan run timer expired")
            self.send_status()

    def handle_command(self, message):
        command = message.upper().replace(" ", "")

        if command == "STATUS":
            self.send_status()
            return

        if command == "STOP":
            self.stop_all_fans("STOP command received")
            self.send("OK: ALL OFF")
            self.send_status()
            return

        if ":" not in command:
            self.send("ERROR: command format should be F1:100")
            return

        target, speed_text = command.split(":", 1)

        try:
            speed = int(speed_text)
        except ValueError:
            self.send("ERROR: speed should be 0/70/85/100")
            return

        if speed not in DUTY_TABLE:
            self.send("ERROR: speed only supports 0, 70, 85, 100")
            return

        if target == "ALL":
            self.set_all_fans(speed)
            self.send("OK: ALL = {}%".format(speed))
            self.send_status()
            return

        if not target.startswith("F"):
            self.send("ERROR: unknown target")
            return

        try:
            fan_id = int(target[1:])
        except ValueError:
            self.send("ERROR: fan id should be F1/F2/F3/F4")
            return

        if fan_id not in fans:
            self.send("ERROR: fan id only supports F1/F2/F3/F4")
            return

        self.set_one_fan(fan_id, speed)
        self.send("OK: F{} = {}%".format(fan_id, speed))
        self.send_status()

    def set_one_fan(self, fan_id, speed):
        current_speed = fan_status[fan_id]

        # Many small brushless fans need a short startup pulse to overcome
        # stall torque before they can sustain 70% / 85% PWM.
        if current_speed == 0 and speed > 0 and speed < 100:
            print("Kickstarting fan {} at 100%".format(fan_id))
            fans[fan_id].duty_u16(DUTY_TABLE[100])
            time.sleep_ms(180)

        fans[fan_id].duty_u16(DUTY_TABLE[speed])
        fan_status[fan_id] = speed
        self.update_fan_run_timer()
        print("Fan {} => {}%".format(fan_id, speed))

    def set_all_fans(self, speed):
        for fan_id in fans:
            self.set_one_fan(fan_id, speed)

    def send_status(self):
        self.send(
            "STATUS: F1={}%, F2={}%, F3={}%, F4={}%".format(
                fan_status[1],
                fan_status[2],
                fan_status[3],
                fan_status[4],
            )
        )

    def send(self, text):
        print("TX:", text)
        payload = (text + "\n").encode()
        for conn_handle in list(self.connections):
            try:
                self.ble.gatts_notify(conn_handle, self.tx_handle, payload)
            except Exception as exc:
                print("Notify failed:", exc)
                self.disconnect_connection(conn_handle)


controller = BleFanController()

print("BLE fan controller started")
print("Device name:", DEVICE_NAME)
print("Commands: F1:100 / F2:85 / F3:70 / F4:0 / ALL:0 / STATUS / STOP")

try:
    while True:
        controller.ensure_advertising()
        controller.check_fan_auto_stop()
        time.sleep_ms(500)
finally:
    controller.shutdown()
