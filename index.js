// Fibaro Melcloud Platform plugin for HomeBridge
//
// Remember to add platform to config.json. Example:
// "platforms": [
//     {
//            "platform": "Melcloud",
//            "name": "Melcloud",
//            "username": "PUT USERNAME OF YOUR MELCLOUD ACCOUNT HERE",
//            "password": "PUT PASSWORD OF YOUR MELCLOUD ACCOUNT HERE"
//     }
// ],
//
// When you attempt to add a device, it will ask for a "PIN code".
// The default code for all HomeBridge accessories is 031-45-154.


let Service;
let Characteristic;

const request = require('request');

class MelcloudBridgedAccessory {

	constructor(services) {
		this.services = services;
	}

	getServices() {
		const services = [];
		const informationService = this.platform.getInformationService(this);
		services.push(informationService);

		for (let s = 0; s < this.services.length; s++) {
			const service = this.services[s];

			for (let i = 0; i < service.characteristics.length; i++) {
				let characteristic = service.controlService.getCharacteristic(service.characteristics[i]);

				if (!characteristic) {
					characteristic = service.controlService.addCharacteristic(service.characteristics[i]);
				}

				this.platform.bindCharacteristicEvents(characteristic, service, this);
			}

			services.push(service.controlService);
		}

		return services;
	}

}

class MelcloudPlatform {

	constructor(log, config) {
		this.log = log;
		this.language = config.language;
		this.username = config.username;
		this.password = config.password;
		this.ContextKey = null;
		this.UseFahrenheit = null;
		this.CurrentHeatingCoolingStateUUID = (new Characteristic.CurrentHeatingCoolingState()).UUID;
		this.TargetHeatingCoolingStateUUID = (new Characteristic.TargetHeatingCoolingState()).UUID;
		this.CurrentTemperatureUUID = (new Characteristic.CurrentTemperature()).UUID;
		this.TargetTemperatureUUID = (new Characteristic.TargetTemperature()).UUID;
		this.TemperatureDisplayUnitsUUID = (new Characteristic.TemperatureDisplayUnits()).UUID;
		this.RotationSpeedUUID = (new Characteristic.RotationSpeed()).UUID;
		this.CurrentHorizontalTiltAngleUUID = (new Characteristic.CurrentHorizontalTiltAngle()).UUID;
		this.TargetHorizontalTiltAngleUUID = (new Characteristic.TargetHorizontalTiltAngle()).UUID;
		this.CurrentVerticalTiltAngleUUID = (new Characteristic.CurrentVerticalTiltAngle()).UUID;
		this.TargetVerticalTiltAngleUUID = (new Characteristic.TargetVerticalTiltAngle()).UUID;
		this.currentAirInfoExecution = 0;
		this.airInfoExecutionPending = [];

		this.model = config.model;
		this.manufacturer = config.manufacturer;
		this.serialNumber = config.serialNumber;
	}

	accessories(callback) {
		this.log('Fetching Melcloud devices...');

		// login
		const url = 'https://app.melcloud.com/Mitsubishi.Wifi.Client/Login/ClientLogin';
		const form = {
			AppVersion: '1.9.3.0',
			CaptchaChallenge: '',
			CaptchaResponse: '',
			Email: this.username,
			Language: this.language,
			Password: this.password,
			Persist: 'true',
		};
		const method = 'post';

		request({ url, form, method }, (err, response) => {
			if (err) {
				this.log(`There was a problem sending login to: ${url}`);
				this.log(err);
				return callback([]);
			}

			try {
				const r = JSON.parse(response.body);
				this.ContextKey = r.LoginData.ContextKey;
				this.UseFahrenheit = r.LoginData.UseFahrenheit;
				this.log(`ContextKey: ${this.ContextKey}`);

				return this.getDevices(callback);
			} catch (e) {
				this.log(`There was a problem parsing login request: ${url}`);
				this.log(e);

				return callback(e);
			}
		});
	}

	getDevices(callback) {
		const url = 'https://app.melcloud.com/Mitsubishi.Wifi.Client/User/ListDevices';
		const method = 'get';

		request({
			url,
			method,
			headers: {
				'X-MitsContextKey': this.ContextKey,
			},
		}, (err, response) => {
			if (err) {
				this.log(`There was a problem getting devices from: ${url}`);
				this.log(err);

				return;
			}

			try {
				const r = JSON.parse(response.body);
				const foundAccessories = [];
				for (let b = 0; b < r.length; b++) {
					const building = r[b];
					let devices = building.Structure.Devices;
					this.createAccessories(building, devices, foundAccessories);

					for (let f = 0; f < building.Structure.Floors.length; f++) {
						devices = building.Structure.Floors[f].Devices;
						this.createAccessories(building, devices, foundAccessories);

						for (let a = 0; a < building.Structure.Floors[f].Areas.length; a++) {
							devices = building.Structure.Floors[f].Areas[a].Devices;
							this.createAccessories(building, devices, foundAccessories);
						}
					}

					for (let a = 0; a < building.Structure.Areas.length; a++) {
						devices = building.Structure.Areas[a].Devices;
						this.createAccessories(building, devices, foundAccessories);
					}
				}
				callback(foundAccessories);
			} catch (e) {
				this.log(`There was a problem parsing devices from: ${url}`);
				this.log(e);
			}
		});
	}

	createAccessories(building, devices, foundAccessories) {
		for (let d = 0; d < devices.length; d++) {
			const device = devices[d];
			const accessory = new MelcloudBridgedAccessory([
				{
					controlService: new Service.Thermostat(device.DeviceName),
					characteristics: [
						Characteristic.CurrentHeatingCoolingState,
						Characteristic.TargetHeatingCoolingState,
						Characteristic.CurrentTemperature,
						Characteristic.TargetTemperature,
						Characteristic.TemperatureDisplayUnits,
						Characteristic.RotationSpeed,
						Characteristic.CurrentHorizontalTiltAngle,
						Characteristic.TargetHorizontalTiltAngle,
						Characteristic.CurrentVerticalTiltAngle,
						Characteristic.TargetVerticalTiltAngle,
					],
				},
			]);

			accessory.platform = this;
			accessory.remoteAccessory = device;
			accessory.id = device.DeviceID;
			accessory.name = device.DeviceName;
			accessory.model = this.model || '';
			accessory.manufacturer = this.manufacturer || 'Mitsubishi';
			accessory.serialNumber = this.serialNumber || device.SerialNumber;
			accessory.airInfo = null;
			accessory.buildingId = building.ID;

			this.log(`Found device: ${device.DeviceName}`);
			foundAccessories.push(accessory);
		}
	}

	proxyAirInfo(callback, characteristic, service, homebridgeAccessory, value, operation) {
		if (homebridgeAccessory.airInfo != null) {
			this.log(`Data already available for: ${homebridgeAccessory.name} - ${characteristic.displayName}`);
			operation(callback, characteristic, service, homebridgeAccessory, value);

			if (this.airInfoExecutionPending.length) {
				const args = this.airInfoExecutionPending.shift();
				//Uncomment due to logfile overload
				//this.log(`Dequeuing remote request for. ${args[3].name} - ${args[1].displayName}`);
				this.proxyAirInfo(...args);
			}

			return;
		}
		//Uncomment due to logfile overload
		//this.log(`Getting data for: ${homebridgeAccessory.name} - ${characteristic.displayName}`);

		if (this.currentAirInfoExecution < 1) {
			homebridgeAccessory.airInfoRequestSent = true;
			this.currentAirInfoExecution++;

			const url = `https://app.melcloud.com/Mitsubishi.Wifi.Client/Device/Get?id=${homebridgeAccessory.id}&buildingID=${homebridgeAccessory.buildingId}`;
			const method = 'get';
			const that = this;

			request({
				url,
				method,
				headers: {
					'X-MitsContextKey': homebridgeAccessory.platform.ContextKey,
				},
			}, (err, response) => {
				if (err || response.body.search('<!DOCTYPE html>') !== -1) {
					that.log(`There was a problem getting info from: ${url}`);
					that.log(`for device: ${homebridgeAccessory.name}`);
					that.log(`Error: ${err}`);
					homebridgeAccessory.airInfo = null;

					callback();
				} else {
					try {
						homebridgeAccessory.airInfo = JSON.parse(response.body);
						operation(callback, characteristic, service, homebridgeAccessory, value);

						// cache airInfo data for 1 minutes
						setTimeout(() => {
							homebridgeAccessory.airInfo = null;
						}, 60 * 1000);
					} catch (e) {
						that.log(`Error: ${e}`);
					}
				}
				that.currentAirInfoExecution--;

				if (that.airInfoExecutionPending.length) {
					const args = that.airInfoExecutionPending.shift();
					that.log(`Dequeuing remote request for: ${args[3].name} - ${args[1].displayName}`);
					that.proxyAirInfo(...args);
				}
			});
		} else {
			//Uncomment due to logfile overload
			//this.log(`Queing remote request data for: ${homebridgeAccessory.name} - ${characteristic.displayName}`);
			this.airInfoExecutionPending.push(arguments);
		}
	}

	getAccessoryValue(callback, characteristic, service, homebridgeAccessory) {
		const r = homebridgeAccessory.airInfo;
		if (characteristic.UUID === homebridgeAccessory.platform.CurrentHeatingCoolingStateUUID) {
			if (r.Power === false) {
				callback(undefined, Characteristic.CurrentHeatingCoolingState.OFF);
			} else {
				switch (r.OperationMode) {
				case 1:
					callback(undefined, Characteristic.CurrentHeatingCoolingState.HEAT);
					return;
				case 3:
					callback(undefined, Characteristic.CurrentHeatingCoolingState.COOL);
					return;
				default:
					// Melcloud can return also 2 (deumidity), 7 (Ventilation), 8 (auto)
					// We try to return 5 which is undefined in homekit
					callback(undefined, 5);
				}
			}
		} else if (characteristic.UUID === homebridgeAccessory.platform.TargetHeatingCoolingStateUUID) {
			if (r.Power === false) {
				callback(undefined, Characteristic.TargetHeatingCoolingState.OFF);
			} else {
				switch (r.OperationMode) {
				case 1:
					callback(undefined, Characteristic.TargetHeatingCoolingState.HEAT);
					return;
				case 3:
					callback(undefined, Characteristic.TargetHeatingCoolingState.COOL);
					return;
				case 8:
					callback(undefined, Characteristic.TargetHeatingCoolingState.AUTO);
					return;
				default:
					// Melcloud can return also 2 (deumidity), 7 (Ventilation)
					// We try to return 5 which is undefined in homekit
					callback(undefined, 5);
				}
			}
		} else if (characteristic.UUID === homebridgeAccessory.platform.CurrentTemperatureUUID) {
			callback(undefined, r.RoomTemperature);
		} else if (characteristic.UUID === homebridgeAccessory.platform.TargetTemperatureUUID) {
			callback(undefined, r.SetTemperature);
		} else if (characteristic.UUID === homebridgeAccessory.platform.TemperatureDisplayUnitsUUID) {
			if (homebridgeAccessory.platform.UseFahrenheit) {
				callback(undefined, Characteristic.TemperatureDisplayUnits.FAHRENHEIT);
			} else {
				callback(undefined, Characteristic.TemperatureDisplayUnits.CELSIUS);
			}
		} else if (characteristic.UUID === homebridgeAccessory.platform.RotationSpeedUUID) {
			const { SetFanSpeed } = r;
			const { NumberOfFanSpeeds } = r;
			const fanSpeed = (SetFanSpeed / NumberOfFanSpeeds) * 100.0;
			callback(undefined, fanSpeed);
		} else if (characteristic.UUID === homebridgeAccessory.platform.CurrentHorizontalTiltAngleUUID
				|| characteristic.UUID === homebridgeAccessory.platform.TargetHorizontalTiltAngleUUID) {

			const { VaneHorizontal } = r;
			const HorizontalTilt = -90.0 + 45.0 * (VaneHorizontal - 1);
			callback(undefined, HorizontalTilt);
		} else if (characteristic.UUID === homebridgeAccessory.platform.CurrentVerticalTiltAngleUUID
				|| characteristic.UUID === homebridgeAccessory.platform.TargetVerticalTiltAngleUUID) {

			const { VaneVertical } = r;
			const VerticallTilt = 90.0 - 45.0 * (5 - VaneVertical);
			callback(undefined, VerticallTilt);
		} else {
			callback(undefined, 0);
		}
	}

	setAccessoryValue(callback, characteristic, service, homebridgeAccessory, value) {
		const r = homebridgeAccessory.airInfo;
		if (characteristic.UUID === homebridgeAccessory.platform.TargetHeatingCoolingStateUUID) {
			switch (value) {
			case Characteristic.TargetHeatingCoolingState.OFF:
				r.Power = false;
				r.EffectiveFlags = 1;
				break;
			case Characteristic.TargetHeatingCoolingState.HEAT:
				r.Power = true;
				r.OperationMode = 1;
				r.EffectiveFlags = 1 + 2;
				break;
			case Characteristic.TargetHeatingCoolingState.COOL:
				r.Power = true;
				r.OperationMode = 3;
				r.EffectiveFlags = 1 + 2;
				break;
			case Characteristic.TargetHeatingCoolingState.AUTO:
				r.Power = true;
				r.OperationMode = 8;
				r.EffectiveFlags = 1 + 2;
				break;
			default:
				callback();
				return;
			}
		} else if (characteristic.UUID === homebridgeAccessory.platform.TargetTemperatureUUID) {
			r.SetTemperature = value;
			r.EffectiveFlags = 4;
		} else if (characteristic.UUID === homebridgeAccessory.platform.TemperatureDisplayUnitsUUID) {
			let UseFahrenheit = false;
			if (value === Characteristic.TemperatureDisplayUnits.FAHRENHEIT) UseFahrenheit = true;

			homebridgeAccessory.platform.updateApplicationOptions(UseFahrenheit);
			homebridgeAccessory.platform.UseFahrenheit = UseFahrenheit;

			callback();
			return;
		} else if (characteristic.UUID === homebridgeAccessory.platform.RotationSpeedUUID) {
			r.SetFanSpeed = ((value / 100.0) * r.NumberOfFanSpeeds).toFixed(0);
			r.EffectiveFlags = 8;
		} else if (characteristic.UUID === homebridgeAccessory.platform.TargetHorizontalTiltAngleUUID) {
			r.VaneHorizontal = ((value + 90.0) / 45.0 + 1.0).toFixed(0);
			r.EffectiveFlags = 256;
		} else if (characteristic.UUID === homebridgeAccessory.platform.TargetVerticalTiltAngleUUID) {
			r.VaneVertical = ((value + 90.0) / 45.0 + 1.0).toFixed(0);
			r.EffectiveFlags = 16;
		} else {
			callback();
			return;
		}

		const url = 'https://app.melcloud.com/Mitsubishi.Wifi.Client/Device/SetAta';
		const method = 'post';
		const body = JSON.stringify(homebridgeAccessory.airInfo);
		const that = this;
		request({
			url,
			method,
			body,
			headers: {
				'X-MitsContextKey': homebridgeAccessory.platform.ContextKey,
				'content-type': 'application/json',
			},
		}, (err) => {
			if (err) {
				that.log(`There was a problem setting info to: ${url}`);
				that.log(err);
			}

			callback();
		});
	}

	updateApplicationOptions(UseFahrenheit) {
		const url = 'https://app.melcloud.com/Mitsubishi.Wifi.Client/User/UpdateApplicationOptions';
		const method = 'post';
		const body = `{UseFahrenheit:${UseFahrenheit},EmailOnCommsError:false,EmailOnUnitError:false,EmailCommsErrors:1,EmailUnitErrors:1,RestorePages:false,MarketingCommunication:false,AlternateEmailAddress:"",Fred:4}`;
		const that = this;
		request({
			url,
			method,
			body,
			headers: {
				'X-MitsContextKey': this.ContextKey,
				'content-type': 'application/json',
			},
		}, (err) => {
			if (err) {
				that.log(`There was a problem setting Application Option to: ${url}`);
				that.log(err);
			}
		});
	}

	getInformationService(homebridgeAccessory) {
		const informationService = new Service.AccessoryInformation();

		informationService
			.setCharacteristic(Characteristic.Name, homebridgeAccessory.name)
			.setCharacteristic(Characteristic.Manufacturer, homebridgeAccessory.manufacturer)
			.setCharacteristic(Characteristic.Model, homebridgeAccessory.model)
			.setCharacteristic(Characteristic.SerialNumber, homebridgeAccessory.serialNumber);

		return informationService;
	}

	bindCharacteristicEvents(characteristic, service, homebridgeAccessory) {
		let readOnly = true;

		for (let i = 0; i < characteristic.props.perms.length; i++) if (characteristic.props.perms[i] === 'pw') readOnly = false;

		if (!readOnly) {
			characteristic
				.on('set', (value, callback, context) => {
					if (context !== 'fromMelcloud') {
						homebridgeAccessory.platform.proxyAirInfo(
							callback,
							characteristic,
							service,
							homebridgeAccessory,
							value,
							homebridgeAccessory.platform.setAccessoryValue,
						);
					}
				});
		}

		characteristic.on('get', (callback) => {
			homebridgeAccessory.platform.proxyAirInfo(
				callback,
				characteristic,
				service,
				homebridgeAccessory,
				null,
				homebridgeAccessory.platform.getAccessoryValue,
			);
		});
	}

	getServices(homebridgeAccessory) {
		const services = [];
		const informationService = homebridgeAccessory.platform.getInformationService(
			homebridgeAccessory,
		);

		services.push(informationService);

		for (let s = 0; s < homebridgeAccessory.services.length; s++) {
			const service = homebridgeAccessory.services[s];
			for (let i = 0; i < service.characteristics.length; i++) {
				let characteristic = service.controlService.getCharacteristic(
					service.characteristics[i],
				);

				if (!characteristic) {
					characteristic = service
						.controlService.addCharacteristic(service.characteristics[i]);
				}

				homebridgeAccessory.platform.bindCharacteristicEvents(
					characteristic,
					service,
					homebridgeAccessory,
				);
			}
			services.push(service.controlService);
		}

		return services;
	}
}

module.exports = (homebridge) => {
	Service = homebridge.hap.Service;
	Characteristic = homebridge.hap.Characteristic;

	homebridge.registerPlatform('homebridge-melcloud2', 'melcloud2', MelcloudPlatform);
};
